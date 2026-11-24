/**
 * Phase 4 Tap-In on the client: the /tap confirmation screen, the student's "I'm at my pickup" entry and
 * Tap-In line, the driver's read-only mark, and the Operations Tap Points list and details. Screens are
 * rendered with react-dom/server from the real realtime store fed by snapshots of the real engine; the
 * submission is exercised through the screen's own submitter against a real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { FastifyInstance } from "fastify";
import type { Persona, RideRequest, StateSnapshot, TripPassenger } from "../../shared/schemas";
import { PERSONAS } from "../../shared/personas";
import { board, cancel, createRequest, dropOff, startTrip, type RideState } from "../../engine/rides";
import { dispatchRequest } from "../../engine/dispatch";
import { advance } from "../../engine/simulation";
import { tapIn } from "../../engine/tapIn";
import { CampusContext } from "./lib/campusContext";
import { createRealtimeStore } from "./lib/realtimeStore";
import type { DriverApi, RideApi } from "./lib/rideApi";
import {
  TAP_IN_ERROR_TEXT, arrivalState, copyText, createTapInApi, createTapInSubmitter, opsTapInText, qrModules, resolveTapPoint, tapCandidates, tapPoints, tapUrl,
  type TapInApi, type TapInResponse,
} from "./lib/tapIn";
import { studentRides } from "./lib/studentRides";
import { FakeSocket, cartAt, lineCampus, liveApp, memoryStorage, recordingStore } from "./lib/testSupport";
import { DriverHome } from "./routes/DriverHome";
import { StudentHome } from "./routes/StudentHome";
import { DetailsPanel } from "./ops/OpsPanels";
import { CopyFeedback, QrCode, TapPointsPanel } from "./ops/TapPointsPanel";
import { TAP_IN_LIMITS, TapInPage, TapInResult } from "./tap/TapInPage";
import { TapInBadge } from "./driver/TapInBadge";

const campus = lineCampus();
const persona = (id: string) => PERSONAS.find((p) => p.id === id)!;
const CARTS = [cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" })];
const neverStudent: RideApi = { createRideRequest: () => Promise.reject(new Error("not used")), cancelRide: () => Promise.reject(new Error("not used")) };
const neverDriver: DriverApi = { rideAction: () => Promise.reject(new Error("not used")) };
const spyTap = () => {
  const calls: unknown[] = [];
  const api: TapInApi = { tapIn: (...args) => { calls.push(args); return Promise.reject(new Error("not expected")); } };
  return { api, calls };
};

const apps: FastifyInstance[] = [];
beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const usePersona = (p: Persona) => vi.stubGlobal("localStorage", memoryStorage({ "jeeny-inside:persona": JSON.stringify(p) }));

function engine(carts = CARTS) {
  const rec = recordingStore(campus, carts);
  const run = (op: (s: RideState) => { ok: boolean }) => {
    const r = rec.store.apply(op as never) as { ok: boolean };
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as unknown as Record<string, unknown>;
  };
  const book = (studentId: string, pickupId: string, destinationId: string, mode?: "shared") =>
    (run((s) => createRequest(s, { studentId, pickupId, destinationId, ...(mode ? { mode } : {}) })).request as { id: string }).id;
  const tap = (id: string, pointId: string, studentId = "stu-lina") => run((s) => tapIn(s, id, { studentId, campusId: "line", pointId }));
  return { rec, run, book, tap };
}
/** Lina b -> d dispatched on CART-01 (assigned, waiting for pickup). */
function linaDispatched() {
  const e = engine();
  const id = e.book("stu-lina", "b", "d");
  e.run((s) => dispatchRequest(s, id));
  return { ...e, id };
}
function liveStore(snapshot: StateSnapshot) {
  const socket = new FakeSocket();
  const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
  store.start();
  socket.serverConnect(snapshot);
  return store;
}
function render(path: string, element: ReactElement, routePath: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <CampusContext.Provider value={campus}>
        <Routes>
          <Route path="/" element={<p>PERSONA PICKER</p>} />
          <Route path={routePath} element={element} />
        </Routes>
      </CampusContext.Provider>
    </MemoryRouter>,
  );
}
const tapScreen = (path: string, snap: StateSnapshot, tapApi: TapInApi = spyTap().api) =>
  render(path, <TapInPage store={liveStore(snap)} api={neverStudent} tapApi={tapApi} personas={PERSONAS} />, "/tap/:campusId/:locationId");
const student = (path: string, snap: StateSnapshot) => render(path, <StudentHome store={liveStore(snap)} api={neverStudent} />, "/student/*");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Tap points and URLs (NFC and QR share one URL)", () => {
  it("supported points are the canStop locations; x (not a stop) is excluded", () => {
    expect(tapPoints(campus).map((l) => l.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("the URL is <base>/tap/<campusId>/<locationId>, and follows the configured host", () => {
    expect(tapUrl("http://10.0.0.5:3000", "line", "b")).toBe("http://10.0.0.5:3000/tap/line/b");
    expect(tapUrl("http://10.0.0.9:3000/", "line", "b")).toBe("http://10.0.0.9:3000/tap/line/b");
  });

  it("a scanned URL resolves to the same campus and point whether it came from a tag or a QR code", () => {
    const url = new URL(tapUrl("http://10.0.0.5:3000", "line", "c"));
    const [, , campusId, locationId] = url.pathname.split("/");
    expect(resolveTapPoint(campus, campusId!, locationId!)).toMatchObject({ kind: "ok", location: { id: "c" } });
    expect(resolveTapPoint(campus, "wadi-cedar", "c").kind).toBe("wrong_campus");
    expect(resolveTapPoint(campus, "line", "zz").kind).toBe("unknown");
    expect(resolveTapPoint(campus, "line", "x").kind).toBe("not_supported");
  });

  it("the QR code encodes a real QR symbol for the URL (finder patterns present) and is deterministic", () => {
    const m = qrModules("http://10.0.0.5:3000/tap/line/b");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect((m.length - 17) % 4).toBe(0); // a valid QR size: 21, 25, 29, ...
    for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]] as const) {
      expect(m[r]!.slice(c, c + 7).every(Boolean)).toBe(true); // top row of each 7x7 finder pattern
    }
    expect(qrModules("http://10.0.0.5:3000/tap/line/b")).toEqual(m);
    expect(qrModules("http://10.0.0.9:3000/tap/line/b")).not.toEqual(m);
  });
});

describe("/tap confirmation screen", () => {
  it("names the point, identifies the ride, and asks for explicit confirmation; rendering sends nothing", () => {
    usePersona(persona("stu-lina"));
    const { rec, id } = linaDispatched();
    const spy = spyTap();
    const html = tapScreen("/tap/line/b", rec.snapshot(), spy.api);
    const t = text(html);
    expect(html).toMatch(/data-testid="tap-point">b</);
    expect(t).toContain("Pickup point · Line");
    expect(html).toContain(`data-testid="tap-candidate-${id}" data-kind="ready"`);
    expect(html).toMatch(/data-testid="tap-confirm"[^>]*>Confirm Tap-In at b</);
    expect(html).not.toContain('data-testid="tap-result"');
    expect(t).toContain(TAP_IN_LIMITS);
    expect(spy.calls).toEqual([]);
  });

  it("no persona on this phone: asks which student is tapping in and keeps the point (no redirect)", () => {
    const html = tapScreen("/tap/line/b", linaDispatched().rec.snapshot());
    expect(html).toContain('data-testid="tap-choose-student"');
    expect(html).toMatch(/data-testid="tap-point">b</);
    expect(html).not.toContain("PERSONA PICKER");
  });

  it("no eligible ride: explains it (booked but not dispatched, or no ride at all)", () => {
    usePersona(persona("stu-lina"));
    const e = engine();
    expect(text(tapScreen("/tap/line/b", e.rec.snapshot()))).toContain("You don't have a ride with a cart assigned.");
    const id = e.book("stu-lina", "b", "d");
    expect(text(tapScreen("/tap/line/b", e.rec.snapshot()))).toContain(`Your ride ${id} doesn't have a cart yet.`);
  });

  it("several eligible rides: the student must choose; nothing is pre-selected and confirm is disabled", () => {
    usePersona(persona("stu-lina"));
    const e = engine();
    const one = e.book("stu-lina", "b", "d");
    e.run((s) => dispatchRequest(s, one));
    const two = e.book("stu-lina", "b", "c");
    e.run((s) => dispatchRequest(s, two));
    const html = tapScreen("/tap/line/b", e.rec.snapshot());
    expect([...html.matchAll(/type="radio"[^>]*name="tap-ride" value="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([one, two].sort());
    expect(html).not.toMatch(/name="tap-ride"[^>]*checked/);
    expect(html).toMatch(/disabled=""[^>]*data-testid="tap-confirm"|data-testid="tap-confirm"[^>]*disabled=""/);
    expect(html).toContain('data-testid="tap-choose-first"');
  });

  it("pickup mismatch: explains the right pickup and offers no confirm; unsupported, unknown and other-campus points are refused", () => {
    usePersona(persona("stu-lina"));
    const { rec, id } = linaDispatched();
    const html = tapScreen("/tap/line/c", rec.snapshot());
    expect(html).toContain(`data-kind="other_pickup"`);
    expect(text(html)).toContain("Your pickup for this ride is b, not c. Tap in there instead.");
    expect(html).not.toContain('data-testid="tap-confirm"');
    expect(html).toContain(`data-testid="tap-note-${id}"`);
    expect(text(tapScreen("/tap/line/x", rec.snapshot()))).toContain("x isn't a pickup point, so you can't tap in here. Nothing was recorded.");
    expect(text(tapScreen("/tap/line/zz", rec.snapshot()))).toContain("names a point Line doesn't have");
    expect(text(tapScreen("/tap/wadi-cedar/b", rec.snapshot()))).toContain("is for another campus");
  });

  it("an existing record here is listed as already tapped in (a replay), with cancelled shown as history", () => {
    usePersona(persona("stu-lina"));
    const e = linaDispatched();
    e.tap(e.id, "b");
    expect(text(tapScreen("/tap/line/b", e.rec.snapshot()))).toContain("Already tapped in here at sim 0:00.");
    e.run((s) => cancel(s, e.id));
    const html = tapScreen("/tap/line/b", e.rec.snapshot());
    expect(html).toContain('data-kind="recorded_here"');
    expect(text(html)).toContain("This ride is cancelled: the Tap-In is history only.");
    expect(text(html)).toContain("Ride status: Cancelled");
  });

  it("the candidate rules: ready, recorded_here (any state), other_pickup; finished rides without a record are not offered", () => {
    const e = linaDispatched();
    const done = e.book("stu-lina", "c", "e");
    e.run((s) => cancel(s, done));
    const rides = () => studentRides(e.rec.snapshot(), "stu-lina");
    expect(tapCandidates(rides(), "b").map((c) => [c.ride.request.id, c.kind])).toEqual([[e.id, "ready"]]);
    expect(tapCandidates(rides(), "c").map((c) => c.kind)).toEqual(["other_pickup"]);
    e.tap(e.id, "b");
    expect(tapCandidates(rides(), "b").map((c) => c.kind)).toEqual(["recorded_here"]);
    expect(tapCandidates(rides(), "c").map((c) => c.kind)).toEqual(["other_pickup"]); // tapped in elsewhere: not sendable here
  });
});

describe("Tap-In submission against a real server (success only after the server's answer)", () => {
  async function serverWithDispatchedRide() {
    const live = await liveApp(apps, campus, CARTS);
    const post = (url: string, body: unknown = {}) => fetch(`${live.url}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const req = await post("/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d" });
    await post(`/api/ride-requests/${req.id}/dispatch`);
    return { ...live, post, id: req.id as string };
  }
  const body = { studentId: "stu-lina", campusId: "line", pointId: "b" };

  it("new Tap-In: sending, then done with alreadyRecorded false; a second submission is a replay with the same record", async () => {
    const live = await serverWithDispatchedRide();
    const api = createTapInApi(live.url);
    const sub = createTapInSubmitter(api);
    const steps: string[] = [];
    sub.subscribe(() => steps.push(sub.getState().step));
    const p = sub.submit(live.id, body);
    void sub.submit(live.id, body); // a second tap while sending is ignored
    await p;
    expect(steps).toEqual(["sending", "done"]);
    const first = sub.getState();
    expect(first.step === "done" && [first.result.alreadyRecorded, first.result.tapIn.locationId]).toEqual([false, "b"]);
    const again = createTapInSubmitter(api);
    await again.submit(live.id, body);
    const second = again.getState();
    expect(second.step === "done" && second.result.alreadyRecorded).toBe(true);
    if (first.step !== "done" || second.step !== "done") throw new Error("expected both submissions to finish");
    expect(second.result.tapIn).toEqual(first.result.tapIn);
  });

  it("a refusal ends in error, never done: pickup mismatch, not your ride, unsupported point", async () => {
    const live = await serverWithDispatchedRide();
    const api = createTapInApi(live.url);
    for (const [b, code] of [
      [{ ...body, pointId: "c" }, "PICKUP_MISMATCH"],
      [{ ...body, studentId: "stu-omar" }, "NOT_YOUR_RIDE"],
      [{ ...body, pointId: "x" }, "POINT_NOT_SUPPORTED"],
    ] as const) {
      const sub = createTapInSubmitter(api);
      await sub.submit(live.id, b);
      expect(sub.getState()).toMatchObject({ step: "error", code });
      expect(TAP_IN_ERROR_TEXT[code]).toBeTruthy();
    }
  });

  it("replay after boarding and after cancellation: the result shows history, never a current arrival", async () => {
    const live = await serverWithDispatchedRide();
    const api = createTapInApi(live.url);
    await createTapInSubmitter(api).submit(live.id, body);
    await live.post(`/api/ride-requests/${live.id}/start`);
    await live.post("/api/simulation/advance", { seconds: 10 });
    await live.post(`/api/ride-requests/${live.id}/board`);
    const afterBoard = createTapInSubmitter(api);
    await afterBoard.submit(live.id, body);
    const st = afterBoard.getState();
    if (st.step !== "done") throw new Error(JSON.stringify(st));
    const boardedHtml = renderToStaticMarkup(<MemoryRouter><TapInResult result={st.result} point={campus.locations[1]!} /></MemoryRouter>);
    expect(text(boardedHtml)).toContain("Already tapped in here at sim 0:00.");
    expect(text(boardedHtml)).toContain("You're already on board (the driver confirmed boarding). The Tap-In is kept as history.");
    expect(boardedHtml).not.toContain("Wait here: your driver confirms boarding.");

    const other = await live.post("/api/ride-requests", { studentId: "stu-omar", pickupId: "c", destinationId: "e" });
    await live.post(`/api/ride-requests/${other.id}/dispatch`);
    const omar = { studentId: "stu-omar", campusId: "line", pointId: "c" };
    await createTapInSubmitter(api).submit(other.id, omar);
    await live.post(`/api/ride-requests/${other.id}/cancel`);
    const afterCancel = createTapInSubmitter(api);
    await afterCancel.submit(other.id, omar);
    const c = afterCancel.getState();
    if (c.step !== "done") throw new Error(JSON.stringify(c));
    expect(c.result.alreadyRecorded).toBe(true);
    const cancelledHtml = renderToStaticMarkup(<MemoryRouter><TapInResult result={c.result} point={campus.locations[2]!} /></MemoryRouter>);
    expect(text(cancelledHtml)).toContain("This ride is cancelled. The Tap-In is kept as history only; it is not a current arrival.");
  });
});

describe("Tap-In result wording", () => {
  const result = (alreadyRecorded: boolean): TapInResponse => {
    const e = linaDispatched();
    e.tap(e.id, "b");
    const snap = e.rec.snapshot();
    return { request: snap.requests[0]!, trip: snap.trips[0]!, cart: snap.carts[0]!, tapIn: { requestId: e.id, locationId: "b", atMs: 0 }, alreadyRecorded };
  };
  const show = (r: TapInResponse) => text(renderToStaticMarkup(<MemoryRouter><TapInResult result={r} point={campus.locations[1]!} /></MemoryRouter>));

  it("a new Tap-In reads 'Tap-In recorded at <point>. Wait here: your driver confirms boarding.' with the limits", () => {
    const t = show(result(false));
    expect(t).toContain("Tap-In recorded at b.");
    expect(t).toContain("Wait here: your driver confirms boarding.");
    expect(t).toContain(TAP_IN_LIMITS);
  });

  it("a replay reads 'Already tapped in here at <time>.'", () => {
    expect(show(result(true))).toContain("Already tapped in here at sim 0:00.");
  });

  it("never claims verified presence, identity, authentication, arrival or boarding", () => {
    for (const t of [show(result(false)), show(result(true))]) {
      const withoutLimits = t.replace(TAP_IN_LIMITS, "");
      expect(withoutLimits).not.toMatch(/\bverified\b|\bauthenticated\b|\bidentity\b|\barrived\b|\bboarded\b|on board now/i);
    }
  });
});

describe("Arrival vs history (a record is a current arrival only at the current pickup)", () => {
  const req = (over: Partial<RideRequest> = {}): RideRequest => ({
    id: "REQ-0001", studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "solo", status: "arriving",
    fareJod: 0.25, freeLoyaltyRide: false, createdAt: 0, updatedAt: 0, priority: false, ...over,
  } as RideRequest);
  const pass = (over: Partial<TripPassenger> = {}): TripPassenger => ({ requestId: "REQ-0001", boarded: false, droppedOff: false, cancelled: false, tappedIn: { locationId: "b", atMs: 5000 }, ...over });

  it("current: at the current pickup and still waiting", () => {
    expect(arrivalState(req(), pass())).toEqual({ kind: "current", locationId: "b", atMs: 5000 });
  });
  it("history: if the assigned pickup were different, the old record is not an arrival at the new pickup", () => {
    expect(arrivalState(req({ pickupId: "c" }), pass())).toEqual({ kind: "history", locationId: "b", atMs: 5000, atCurrentPickup: false });
    expect(renderToStaticMarkup(<TapInBadge arrival={arrivalState(req({ pickupId: "c" }), pass())} />)).toBe("");
    expect(opsTapInText(req({ pickupId: "c" }), pass(), (id) => id)).toBe("Tap-In recorded sim 0:05 at b (not verified), history: not the current pickup");
  });
  it("history after boarding, drop-off and cancellation; nothing without a record", () => {
    expect(arrivalState(req({ status: "on_board" }), pass({ boarded: true }))?.kind).toBe("history");
    expect(arrivalState(req({ status: "completed" }), pass({ boarded: true, droppedOff: true }))?.kind).toBe("history");
    expect(arrivalState(req({ status: "cancelled" }), pass({ cancelled: true }))?.kind).toBe("history");
    expect(arrivalState(req(), pass({ tappedIn: undefined }))).toBeNull();
  });
});

describe("Student app entry and ride card", () => {
  it("a dispatched, waiting ride offers 'I'm at my pickup', linking to the same /tap URL for its pickup", () => {
    usePersona(persona("stu-lina"));
    const html = student("/student", linaDispatched().rec.snapshot());
    expect(html).toMatch(/<a [^>]*href="\/tap\/line\/b"[^>]*>I&#x27;m at my pickup</);
    expect(html).toMatch(/<a [^>]*data-testid="tap-entry"[^>]*href="\/tap\/line\/b"/);
  });

  it("after a Tap-In the card shows it as a current check-in (not boarding) and the entry goes away", () => {
    usePersona(persona("stu-lina"));
    const e = linaDispatched();
    e.tap(e.id, "b");
    const html = student("/student", e.rec.snapshot());
    expect(html).toMatch(/data-testid="ride-tapin" data-arrival="current">Tapped in at b · sim 0:00. Wait here: your driver confirms boarding.</);
    expect(html).not.toContain('data-testid="tap-entry"');
    expect(html).toMatch(/data-testid="ride-phase">Cart assigned</); // not "On board"
  });

  it("a requested (not dispatched) ride has no entry; after cancellation the record shows as history", () => {
    usePersona(persona("stu-lina"));
    const e = engine();
    e.book("stu-lina", "b", "d");
    expect(student("/student", e.rec.snapshot())).not.toContain('data-testid="tap-entry"');
    const d = linaDispatched();
    d.tap(d.id, "b");
    d.run((s) => cancel(s, d.id));
    const html = student(`/student/rides/${d.id}`, d.rec.snapshot());
    expect(html).toMatch(/data-arrival="history">Earlier Tap-In at b · sim 0:00 \(this ride is cancelled\)</);
    expect(text(html)).toContain("Tap-In b at sim 0:00 (check-in only, not verified)");
  });
});

describe("Driver: read-only Tap-In", () => {
  it("shows 'Tapped in · not boarded' while the rider waits; boarding stays the driver's own button", () => {
    usePersona(persona("drv-yazan"));
    const e = linaDispatched();
    e.run((s) => startTrip(s, e.id));
    e.run((s) => advance(s, 10)); // at b
    e.tap(e.id, "b");
    const html = render("/driver", <DriverHome store={liveStore(e.rec.snapshot())} api={neverDriver} personas={PERSONAS} />, "/driver");
    expect(html).toMatch(/data-testid="driver-tapin"[^>]*>Tapped in · not boarded</);
    expect([...html.matchAll(/data-testid="trip-action"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["Confirm boarding"]);
    expect(e.rec.snapshot().requests[0]!.status).toBe("arriving");
  });

  it("no mark once boarded; and the shared card marks only the rider who tapped in", () => {
    usePersona(persona("drv-yazan"));
    const e = linaDispatched();
    e.run((s) => startTrip(s, e.id));
    e.run((s) => advance(s, 10));
    e.tap(e.id, "b");
    e.run((s) => board(s, e.id));
    const html = render("/driver", <DriverHome store={liveStore(e.rec.snapshot())} api={neverDriver} personas={PERSONAS} />, "/driver");
    expect(html).not.toContain('data-testid="driver-tapin"');

    const s = engine();
    const A = s.book("stu-lina", "b", "d", "shared");
    s.run((st) => dispatchRequest(st, A));
    const B = s.book("stu-omar", "c", "e", "shared");
    s.run((st) => dispatchRequest(st, B));
    s.tap(B, "c", "stu-omar");
    const shared = render("/driver", <DriverHome store={liveStore(s.rec.snapshot())} api={neverDriver} personas={PERSONAS} />, "/driver");
    expect(shared.match(/data-testid="driver-tapin"/g)).toHaveLength(1);
    expect(shared).toMatch(/Tapped in · not boarded<\/span><span class="[^"]*" data-testid="rider-state-REQ-0002">Waiting for pickup</);
  });

  it("a later drop-off is unaffected by a Tap-In", () => {
    const e = linaDispatched();
    e.tap(e.id, "b");
    e.run((s) => startTrip(s, e.id));
    e.run((s) => advance(s, 10));
    e.run((s) => board(s, e.id));
    e.run((s) => advance(s, 20));
    e.run((s) => dropOff(s, e.id));
    expect(e.rec.snapshot().requests[0]!.status).toBe("completed");
  });
});

describe("Operations: Tap Points and details", () => {
  const panel = (baseUrl: string | null) => renderToStaticMarkup(<TapPointsPanel campus={campus} baseUrl={baseUrl} />);

  it("lists every supported point with its URL from the configured host, and the host-change warning", () => {
    const html = panel("http://10.0.0.5:3000");
    const urls = [...html.matchAll(/data-testid="tap-point-url" value="([^"]+)"/g)].map((m) => m[1]);
    expect(urls).toEqual(["a", "b", "c", "d", "e"].map((id) => `http://10.0.0.5:3000/tap/line/${id}`));
    expect(html).not.toContain('data-testid="tap-point-x"');
    expect(text(html)).toContain("Tap Points · Line");
    expect(text(html)).toContain("If the host changes, every NFC tag must be rewritten and every QR code reprinted.");
  });

  it("the QR code shown for a point carries exactly the URL written to its NFC tag", () => {
    const url = tapUrl("http://10.0.0.5:3000", "line", "b");
    const html = renderToStaticMarkup(<QrCode text={url} label="QR" />);
    expect(html).toContain(`data-qr-text="${url}"`);
    expect(html).toContain(`>${url}</figcaption>`);
    expect(html).toMatch(/<path d="M4 4h1v1h-1z/); // the first dark module (top-left finder) inside the quiet zone
  });

  it("changing the configured host changes every generated URL", () => {
    const urls = (html: string) => [...html.matchAll(/data-testid="tap-point-url" value="([^"]+)"/g)].map((m) => m[1]);
    expect(urls(panel("http://192.168.137.1:3000"))[1]).toBe("http://192.168.137.1:3000/tap/line/b");
    expect(urls(panel("http://demo-laptop.local:3000"))[1]).toBe("http://demo-laptop.local:3000/tap/line/b");
  });

  it("without a configured host: no URLs, and instructions to set one (never a guessed address)", () => {
    const html = panel(null);
    expect(html).toContain('data-testid="tap-points-no-host"');
    expect(html).not.toContain('data-testid="tap-point-url"');
    expect(text(html)).toContain("--public-host=");
  });

  it("request and trip details show 'Tap-In recorded <time> at <point> (not verified)'", () => {
    const e = linaDispatched();
    e.run((s) => startTrip(s, e.id));
    e.run((s) => advance(s, 10));
    e.tap(e.id, "b");
    const snap = e.rec.snapshot();
    const details = (selected: { kind: "request" | "trip"; id: string }) =>
      text(renderToStaticMarkup(<DetailsPanel data={snap} campus={campus} personas={PERSONAS} selected={selected} onClear={() => {}} />));
    expect(details({ kind: "request", id: e.id })).toContain("Tap-In recorded sim 0:10 at b (not verified), waiting for the driver to board");
    expect(details({ kind: "trip", id: snap.trips[0]!.id })).toContain(`${e.id}: Tap-In recorded sim 0:10 at b (not verified)`);
  });
});

describe("Operations Tap Points: Copy URL feedback (audit fix F4)", () => {
  const url = "http://10.0.0.5:3000/tap/line/b";

  it("copies with the Clipboard API when available and reports success", async () => {
    const written: string[] = [];
    expect(await copyText(url, { writeText: async (t: string) => { written.push(t); } })).toBe("copied");
    expect(written).toEqual([url]); // the exact generated URL, unchanged
  });

  it("falls back to manual copy when the Clipboard API is missing (plain HTTP) or refuses", async () => {
    expect(await copyText(url, undefined)).toBe("manual");
    expect(await copyText(url, { writeText: () => Promise.reject(new DOMException("Not allowed", "NotAllowedError")) })).toBe("manual");
    expect(await copyText(url, {} as Clipboard)).toBe("manual");
  });

  it("success shows a clear confirmation; the fallback is visible and explains how to copy by hand", () => {
    expect(renderToStaticMarkup(<CopyFeedback outcome="copied" />)).toMatch(/role="status"[^>]*data-testid="tap-copy-ok"[^>]*>Copied to the clipboard\.</);
    const manual = renderToStaticMarkup(<CopyFeedback outcome="manual" />);
    expect(manual).toMatch(/role="alert"[^>]*data-testid="tap-copy-manual"/);
    expect(text(manual)).toContain("The URL above is selected: copy it with Ctrl+C or Cmd+C, or press and hold it and choose Copy.");
  });

  it("each point has a Copy URL button and a selectable URL field with a stable id, and no feedback before a press", () => {
    const html = renderToStaticMarkup(<TapPointsPanel campus={campus} baseUrl="http://10.0.0.5:3000" />);
    expect(html.match(/data-testid="tap-point-copy"/g)).toHaveLength(5);
    expect(html).toMatch(/id="tap-url-b"[^>]*readOnly=""[^>]*data-testid="tap-point-url" value="http:\/\/10\.0\.0\.5:3000\/tap\/line\/b"/);
    expect(html).not.toMatch(/tap-copy-(ok|manual)/);
  });
});
