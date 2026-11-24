/**
 * Phase 4 Prompt 2: the Ghost Ride screens rendered with React (react-dom/server, no browser), fed by
 * the real realtime store with snapshots from the real engine, plus the Operations dispatch panel
 * after real dispatches against a real server. Covers the booking mode choice (Solo default), shared
 * ride states for the student, the driver's ordered stops and per-rider buttons, and shared trips and
 * dispatch outcomes in Operations, and that solo screens keep their Phase 3 content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { FastifyInstance } from "fastify";
import type { Persona, StateSnapshot } from "../../shared/schemas";
import { PERSONAS } from "../../shared/personas";
import { board, createRequest, startTrip, type RideState } from "../../engine/rides";
import { dispatchRequest } from "../../engine/dispatch";
import { advance } from "../../engine/simulation";
import { CampusContext } from "./lib/campusContext";
import { createDispatchController } from "./lib/opsActions";
import { createRealtimeStore } from "./lib/realtimeStore";
import { createOpsApi, type DriverApi, type OpsApi, type RideApi } from "./lib/rideApi";
import { FakeSocket, cartAt, lineCampus, liveApp, memoryStorage, recordingStore } from "./lib/testSupport";
import { DispatchPanel } from "./ops/OpsPanels";
import { DriverHome } from "./routes/DriverHome";
import { OpsHome } from "./routes/OpsHome";
import { StudentHome } from "./routes/StudentHome";

const persona = (id: string) => PERSONAS.find((p) => p.id === id)!;
const CARTS = [cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" })];
const neverStudent: RideApi = { createRideRequest: () => Promise.reject(new Error("not used")), cancelRide: () => Promise.reject(new Error("not used")) };
const neverDriver: DriverApi = { rideAction: () => Promise.reject(new Error("not used")) };
const neverOps: OpsApi = { dispatch: () => Promise.reject(new Error("not used")), advance: () => Promise.reject(new Error("not used")) };

const apps: FastifyInstance[] = [];
beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const usePersona = (p: Persona) => vi.stubGlobal("localStorage", memoryStorage({ "jeeny-inside:persona": JSON.stringify(p) }));

function engine(carts = CARTS) {
  const rec = recordingStore(lineCampus(), carts);
  const run = (op: (s: RideState) => { ok: boolean }) => {
    const r = rec.store.apply(op as never) as { ok: boolean };
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as unknown as Record<string, unknown>;
  };
  const book = (studentId: string, pickupId: string, destinationId: string, mode?: "shared") =>
    (run((s) => createRequest(s, { studentId, pickupId, destinationId, ...(mode ? { mode } : {}) })).request as { id: string }).id;
  return { rec, run, book };
}
/** Lina (b -> d) on a new CART-01 trip; Omar (c -> e) joins it. Stops b, c, d, e. */
function sharedTrip() {
  const e = engine();
  const A = e.book("stu-lina", "b", "d", "shared");
  e.run((s) => dispatchRequest(s, A));
  const B = e.book("stu-omar", "c", "e", "shared");
  e.run((s) => dispatchRequest(s, B));
  return { ...e, A, B };
}
function liveStore(snapshot: StateSnapshot) {
  const socket = new FakeSocket();
  const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
  store.start();
  socket.serverConnect(snapshot);
  return store;
}
function render(path: string, element: ReactElement) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <CampusContext.Provider value={lineCampus()}>
        <Routes>
          <Route path="/" element={<p>PERSONA PICKER</p>} />
          <Route path={`${path.split("/").slice(0, 2).join("/")}/*`} element={element} />
        </Routes>
      </CampusContext.Provider>
    </MemoryRouter>,
  );
}
const student = (path: string, snap: StateSnapshot) => render(path, <StudentHome store={liveStore(snap)} api={neverStudent} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Student screens", () => {
  it("the booking form offers Solo and Shared, with Solo selected by default and no promise of a match", () => {
    usePersona(persona("stu-lina"));
    const html = student("/student", engine().rec.snapshot());
    expect(html).toMatch(/name="ride-mode" checked="" value="solo"/);
    expect(html).toMatch(/name="ride-mode" value="shared"/);
    expect(html).not.toMatch(/checked="" value="shared"/);
    expect(text(html)).toContain("Solo: a cart for your ride only.");
    expect(text(html)).not.toMatch(/guaranteed match|you will be matched/i);
  });

  it("a shared request awaiting dispatch says Shared and Not matched yet, never joined", () => {
    usePersona(persona("stu-lina"));
    const e = engine();
    e.book("stu-lina", "b", "d", "shared");
    const t = text(student("/student", e.rec.snapshot()));
    expect(t).toContain("Shared");
    expect(t).toContain("Not matched yet");
    expect(t).not.toMatch(/joined a trip|Sharing with/);
  });

  it("a joined rider sees their own ride, the trip's status separately, and other riders only as a count", () => {
    usePersona(persona("stu-omar"));
    const { rec } = sharedTrip();
    const html = student("/student", rec.snapshot());
    const t = text(html);
    expect(t).toContain("Your ride joined a trip that was already planned.");
    expect(t).toContain("Sharing with 1 other rider.");
    expect(t).toContain("1 stop before your pickup.");
    expect(html).toMatch(/data-testid="ride-phase">Cart assigned</);
    expect(html).toMatch(/data-testid="shared-trip-status">Planned, not started/);
    expect(t).not.toMatch(/Lina|stu-lina|REQ-0001/);
  });

  it("another student's request id is not found in this student's screens (no cancel button for it)", () => {
    usePersona(persona("stu-omar"));
    const { rec, A } = sharedTrip();
    const t = text(student(`/student/rides/${A}`, rec.snapshot()));
    expect(t).toContain("This ride was not found among your rides.");
    expect(t).not.toContain("Cancel ride");
  });

  it("a solo ride's card has no shared lines", () => {
    usePersona(persona("stu-lina"));
    const e = engine();
    const id = e.book("stu-lina", "c", "e");
    e.run((s) => dispatchRequest(s, id));
    const html = student("/student", e.rec.snapshot());
    expect(html).not.toContain('data-testid="shared-info"');
    expect(html).not.toContain('data-testid="ride-shared"');
    expect(html).toMatch(/data-testid="ride-phase">Cart assigned</);
  });
});

describe("Driver screen", () => {
  it("lists the server's ordered stops and riders, and offers boarding only for the rider at the current stop", () => {
    usePersona(persona("drv-yazan"));
    const { rec, run, A, B } = sharedTrip();
    run((s) => startTrip(s, A));
    run((s) => advance(s, 10)); // at b
    const html = render("/driver", <DriverHome store={liveStore(rec.snapshot())} api={neverDriver} personas={PERSONAS} />);
    const t = text(html);
    expect(html).toContain('data-testid="shared-trip"');
    expect(t).toMatch(/1\. b .*2\. c .*3\. d .*4\. e /);
    expect(html).toMatch(/data-testid="shared-committed">2 of 4 seats committed</);
    expect(html).toMatch(/data-testid="shared-onboard">0 on board</);
    expect(html).toMatch(new RegExp(`data-testid="rider-state-${A}">Waiting for pickup<`));
    expect(html).toMatch(new RegExp(`data-testid="rider-state-${B}">Waiting for pickup<`));
    const buttons = [...html.matchAll(/data-testid="trip-action"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(buttons).toEqual([`Confirm boarding: Lina (${A})`]);
    expect(t).not.toMatch(/add (a )?(rider|passenger)/i);
  });

  it("after one boarding, that rider is On board and the other still waits", () => {
    usePersona(persona("drv-yazan"));
    const { rec, run, A, B } = sharedTrip();
    run((s) => startTrip(s, A));
    run((s) => advance(s, 10));
    run((s) => board(s, A));
    const html = render("/driver", <DriverHome store={liveStore(rec.snapshot())} api={neverDriver} personas={PERSONAS} />);
    expect(html).toMatch(new RegExp(`data-testid="rider-state-${A}">On board<`));
    expect(html).toMatch(new RegExp(`data-testid="rider-state-${B}">Waiting for pickup<`));
    expect(html).toMatch(/data-testid="shared-onboard">1 on board</);
    expect(html).toContain('data-testid="trip-unavailable"'); // driving to c: no button yet
  });

  it("a solo trip keeps the Phase 3 card", () => {
    usePersona(persona("drv-yazan"));
    const e = engine();
    const id = e.book("stu-lina", "c", "e");
    e.run((s) => dispatchRequest(s, id));
    const html = render("/driver", <DriverHome store={liveStore(e.rec.snapshot())} api={neverDriver} personas={PERSONAS} />);
    expect(html).not.toContain('data-testid="shared-trip"');
    expect(html).toMatch(/data-testid="trip-action"[^>]*>Start trip</);
    expect(html).toMatch(/data-testid="trip-passenger">Lina \(stu-lina\)</);
  });
});

describe("Operations screens", () => {
  it("the trips table marks a shared trip and shows committed and on-board riders separately", () => {
    usePersona(persona("ops-hadi"));
    const { rec } = sharedTrip();
    const html = render("/ops", <OpsHome store={liveStore(rec.snapshot())} api={neverOps} personas={PERSONAS} />);
    expect(html).toMatch(/data-testid="trip-shared">Shared</);
    expect(html).toMatch(/data-testid="trip-riders">2 committed · 0 on board</);
  });

  it("a solo trip row has no shared marks", () => {
    usePersona(persona("ops-hadi"));
    const e = engine();
    const id = e.book("stu-lina", "c", "e");
    e.run((s) => dispatchRequest(s, id));
    const html = render("/ops", <OpsHome store={liveStore(e.rec.snapshot())} api={neverOps} personas={PERSONAS} />);
    expect(html).not.toContain('data-testid="trip-shared"');
    expect(html).not.toContain('data-testid="trip-riders"');
  });

  it("the dispatch panel shows the server's joined outcome and the trip it checked", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const post = (url: string, payload: object = {}) => live.app.inject({ method: "POST", url, payload });
    const A = (await post("/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" })).json().id as string;
    await post(`/api/ride-requests/${A}/dispatch`);
    const B = (await post("/api/ride-requests", { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" })).json().id as string;
    const snap = (await (await fetch(`${live.url}/api/snapshot`)).json()) as StateSnapshot;
    const dispatch = createDispatchController({ api: createOpsApi(live.url), currentData: () => snap, resync: () => {} });
    expect(await dispatch.submit(B)).toBe("sent");
    const t = text(renderToStaticMarkup(<DispatchPanel data={snap} campus={lineCampus()} personas={PERSONAS} dispatch={dispatch} onSelect={() => {}} />));
    expect(t).toContain(`${B} joined shared trip TRIP-0001 on CART-01 (CART-01), by the server.`);
    expect(t).toContain("Shared ride: Joined TRIP-0001 on CART-01.");
    expect(t).toContain("TRIP-0001 on CART-01 (planned trip) can join: rank 1 (joined)");
    expect(t).toContain("Stops after joining: b → c → d → e");
  });

  it("a refused shared dispatch explains the excluded trip in plain words plus the server's reason", async () => {
    const live = await liveApp(apps, lineCampus(), [cartAt("CART-01", "a")]);
    const post = (url: string, payload: object = {}) => live.app.inject({ method: "POST", url, payload });
    const A = (await post("/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" })).json().id as string;
    await post(`/api/ride-requests/${A}/dispatch`);
    const B = (await post("/api/ride-requests", { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" })).json().id as string;
    const snap = (await (await fetch(`${live.url}/api/snapshot`)).json()) as StateSnapshot;
    const dispatch = createDispatchController({ api: createOpsApi(live.url), currentData: () => snap, resync: () => {} });
    expect(await dispatch.submit(B)).toBe("failed");
    const t = text(renderToStaticMarkup(<DispatchPanel data={snap} campus={lineCampus()} personas={PERSONAS} dispatch={dispatch} onSelect={() => {}} />));
    expect(t).toContain(`${B} not dispatched`);
    expect(t).toContain("Shared ride: Neither joined a trip nor got a cart.");
    expect(t).toContain("not joinable: No cart could take this ride alone right now");
    expect(t).toContain("Server:");
  });
});
