/**
 * Phase 4 Prompt 2: the Ghost Ride client logic (Student, Driver and Operations data layers) against
 * real server state. Engine-driven states come from the real engine through the real server store;
 * API cases run against a real Fastify + Socket.IO server on a random port with the same rideApi,
 * booking, driverActions, opsActions and realtimeStore code the app uses. Nothing here re-implements
 * matching or delay rules: every shared fact checked below is read from server data.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { io } from "socket.io-client";
import type { StateSnapshot } from "../../shared/schemas";
import { board as engineBoard, createRequest, startTrip as engineStart, type RideState } from "../../engine/rides";
import { dispatchRequest } from "../../engine/dispatch";
import { advance } from "../../engine/simulation";
import { createBookingController } from "./lib/booking";
import { createDriverActionController } from "./lib/driverActions";
import { bindingStillValid, isSharedTrip, openTripsForCart, tripView, type ActionBinding } from "./lib/driverWork";
import { createDispatchController } from "./lib/opsActions";
import { JOIN_EXCLUSION_TEXT, tripRiderCounts } from "./lib/opsMetrics";
import { createRealtimeStore, type RealtimeStore } from "./lib/realtimeStore";
import { createDriverApi, createOpsApi, createRideApi, type DriverApi } from "./lib/rideApi";
import { canCancel, sharedCancelNote, sharedRideLines, sharedTripInfo, studentRides } from "./lib/studentRides";
import { FakeSocket, cartAt, lineCampus, liveApp, recordingStore, waitFor, type Live } from "./lib/testSupport";

const CARTS = [cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" })];

const apps: FastifyInstance[] = [];
const stores: RealtimeStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.stop();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** Engine-driven server state: run real engine operations through the real server store. */
function engine(carts = CARTS) {
  const rec = recordingStore(lineCampus(), carts);
  const run = (op: (s: RideState) => { ok: boolean }) => {
    const r = rec.store.apply(op as never) as { ok: boolean };
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as unknown as Record<string, unknown>;
  };
  const book = (studentId: string, pickupId: string, destinationId: string, mode?: "solo" | "shared") =>
    (run((s) => createRequest(s, { studentId, pickupId, destinationId, ...(mode ? { mode } : {}) })).request as { id: string }).id;
  const dispatch = (id: string) => run((s) => dispatchRequest(s, id));
  const tick = (seconds: number) => run((s) => advance(s, seconds));
  return { rec, run, book, dispatch, tick };
}

/**
 * Lina (shared, b -> d) gets CART-01 on a new trip; Omar (shared, c -> e) joins it (his solo baseline
 * comes from CART-02 at e). The server orders the stops b, c, d, e.
 */
function sharedTrip() {
  const e = engine();
  const A = e.book("stu-lina", "b", "d", "shared");
  e.dispatch(A);
  const B = e.book("stu-omar", "c", "e", "shared");
  e.dispatch(B);
  return { ...e, A, B };
}
const rideOf = (snap: StateSnapshot, studentId: string) => studentRides(snap, studentId)[0]!;
const view = (snap: StateSnapshot) => openTripsForCart(snap, "CART-01")[0]!;
const actionsOf = (snap: StateSnapshot) => view(snap).actions.map((a) => `${a.action} ${a.requestId}`);

// ---------- Student: booking mode ----------

describe("Student booking mode", () => {
  async function bookingWith(mode?: "solo" | "shared") {
    const e = engine();
    const sent: unknown[] = [];
    const api = createRideApi("http://test", async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "REQ-0001", studentId: "stu-lina", pickupId: "c", destinationId: "e", mode: mode ?? "solo", status: "requested", fareJod: 0.25, freeLoyaltyRide: false, createdAt: 0, updatedAt: 0 }), { status: 201 });
    });
    const snap = e.rec.snapshot();
    const controller = createBookingController({ api, campus: lineCampus(), currentData: () => snap });
    expect(await controller.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "e", ...(mode ? { mode } : {}) })).toBe("sent");
    return sent;
  }

  it("1. solo is the default: no mode, or mode solo, sends exactly the pre-Phase-4 body", async () => {
    expect(await bookingWith()).toEqual([{ studentId: "stu-lina", pickupId: "c", destinationId: "e" }]);
    expect(await bookingWith("solo")).toEqual([{ studentId: "stu-lina", pickupId: "c", destinationId: "e" }]);
  });

  it("2. shared is sent through the existing create contract, and the real server stores it as shared", async () => {
    expect(await bookingWith("shared")).toEqual([{ studentId: "stu-lina", pickupId: "c", destinationId: "e", mode: "shared" }]);
    const live = await liveApp(apps, lineCampus(), CARTS);
    const res = await createRideApi(live.url).createRideRequest({ studentId: "stu-lina", pickupId: "c", destinationId: "e", mode: "shared" });
    expect(res).toMatchObject({ ok: true, value: { mode: "shared", status: "requested", fareJod: 0.25 } });
  });
});

// ---------- Student: shared states ----------

describe("Student shared ride states (from server data only)", () => {
  it("3. a shared request awaiting dispatch is never shown as matched", () => {
    const e = engine();
    e.book("stu-lina", "b", "d", "shared");
    const ride = rideOf(e.rec.snapshot(), "stu-lina");
    expect(ride.phase).toBe("requested");
    expect(sharedTripInfo(ride)).toBeNull();
    const lines = sharedRideLines(ride).join(" ");
    expect(lines).toContain("Not matched yet");
    expect(lines).not.toMatch(/joined|Sharing with|assigned/i);
  });

  it("3b. a failed shared dispatch (409) leaves the request requested, and it is still shown as not matched", () => {
    const e = engine([cartAt("CART-01", "a", { driverId: "drv-yazan" })]);
    const A = e.book("stu-lina", "b", "d", "shared");
    e.dispatch(A);
    const B = e.book("stu-omar", "c", "e", "shared");
    const refused = e.rec.store.apply((s) => dispatchRequest(s, B) as never) as { ok: boolean; error?: { code: string } };
    expect(refused).toMatchObject({ ok: false, error: { code: "NO_CART_AVAILABLE" } });
    const omar = rideOf(e.rec.snapshot(), "stu-omar");
    expect(omar.request.status).toBe("requested");
    expect(sharedRideLines(omar).join(" ")).toContain("Not matched yet");
  });

  it("4 and 5. joined and new-cart appear only once the server has dispatched, read from the trip's passenger list", () => {
    const e = engine();
    const A = e.book("stu-lina", "b", "d", "shared");
    const B = e.book("stu-omar", "c", "e", "shared");
    expect(sharedTripInfo(rideOf(e.rec.snapshot(), "stu-lina"))).toBeNull();
    e.dispatch(A);
    let snap = e.rec.snapshot();
    expect(sharedTripInfo(rideOf(snap, "stu-lina"))).toMatchObject({ origin: "new_cart", otherRiders: 0, onBoard: 0, stopsBeforePickup: 0 });
    expect(sharedRideLines(rideOf(snap, "stu-lina")).join(" ")).toContain("A cart was assigned to your ride.");
    expect(sharedTripInfo(rideOf(snap, "stu-omar"))).toBeNull(); // not dispatched yet: no claim of a match
    e.dispatch(B);
    snap = e.rec.snapshot();
    expect(sharedTripInfo(rideOf(snap, "stu-omar"))).toMatchObject({ origin: "joined", otherRiders: 1, stopsBeforePickup: 1, stopsBeforeDropOff: 3 });
    expect(sharedRideLines(rideOf(snap, "stu-omar")).join(" ")).toContain("Your ride joined a trip that was already planned.");
    expect(sharedTripInfo(rideOf(snap, "stu-lina"))).toMatchObject({ origin: "new_cart", otherRiders: 1 });
  });

  it("other riders appear only as counts: no names, ids or locations of other students", () => {
    const { rec } = sharedTrip();
    const lines = sharedRideLines(rideOf(rec.snapshot(), "stu-lina")).join(" ");
    expect(lines).toContain("Sharing with 1 other rider.");
    expect(lines).not.toMatch(/omar|REQ-0002|stu-/i);
  });

  it("6. a student's rides are only their own requests, so cancel can only target their own request", () => {
    const { rec, A, B } = sharedTrip();
    const snap = rec.snapshot();
    expect(studentRides(snap, "stu-lina").map((r) => r.request.id)).toEqual([A]);
    expect(studentRides(snap, "stu-omar").map((r) => r.request.id)).toEqual([B]);
  });

  it("per-rider cancel: only the cancelled rider's ride ends; the note explains the trip continues for others", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const api = createRideApi(live.url);
    const post = (url: string) => live.app.inject({ method: "POST", url, payload: {} });
    const a = (await api.createRideRequest({ studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" }));
    const b = (await api.createRideRequest({ studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" }));
    if (!a.ok || !b.ok) throw new Error("create failed");
    await post(`/api/ride-requests/${a.value.id}/dispatch`);
    await post(`/api/ride-requests/${b.value.id}/dispatch`);
    const before = (await (await fetch(`${live.url}/api/snapshot`)).json()) as StateSnapshot;
    const omar = rideOf(before, "stu-omar");
    expect(canCancel(omar)).toBe(true);
    expect(sharedCancelNote(omar)).toBe("Cancelling removes only your ride. The trip continues for the other riders.");

    const res = await api.cancelRide(b.value.id);
    expect(res).toMatchObject({ ok: true, value: { id: b.value.id, status: "cancelled" } });
    const after = (await (await fetch(`${live.url}/api/snapshot`)).json()) as StateSnapshot;
    expect(rideOf(after, "stu-lina")).toMatchObject({ phase: "assigned", active: true });
    expect(rideOf(after, "stu-lina").trip).toMatchObject({ status: "planned", stops: [{ locationId: "b" }, { locationId: "d" }] });
    expect(rideOf(after, "stu-omar")).toMatchObject({ phase: "cancelled", active: false });
    expect(sharedCancelNote(rideOf(after, "stu-lina"))).toBeNull(); // nobody else is left on the trip
  });

  it("cancel is offered only before boarding, and the server's refusal is reported, not hidden", async () => {
    const { rec, run, A, tick } = sharedTrip();
    run((s) => engineStart(s, A));
    tick(10);
    run((s) => engineBoard(s, A));
    expect(canCancel(rideOf(rec.snapshot(), "stu-lina"))).toBe(false);
    const res = await createRideApi("http://test", async () => new Response(JSON.stringify({ error: "REQ-0001 is on board and cannot be cancelled", code: "CANNOT_CANCEL_ON_BOARD" }), { status: 409 })).cancelRide(A);
    expect(res).toEqual({ ok: false, status: 409, code: "CANNOT_CANCEL_ON_BOARD", message: "REQ-0001 is on board and cannot be cancelled" });
  });
});

// ---------- Driver: ordered stops and per-rider actions ----------

describe("Driver shared trip view", () => {
  it("shows the server's ordered stops, each rider's own state, and committed riders against seats", () => {
    const { rec, A, B } = sharedTrip();
    const v = view(rec.snapshot());
    expect(v.shared).not.toBeNull();
    expect(v.request).toBeNull();
    expect(v.shared!.stops.map((s) => [s.locationId, s.board, s.alight, s.status])).toEqual([
      ["b", [A], [], "next"], ["c", [B], [], "later"], ["d", [], [A], "later"], ["e", [], [B], "later"],
    ]);
    expect(v.shared!.riders.map((r) => [r.requestId, r.state])).toEqual([[A, "waiting"], [B, "waiting"]]);
    expect(v.shared!).toMatchObject({ committed: 2, onBoard: 0, seats: 4 });
    // Planned: one trip-level start, sent through an assigned rider's request.
    expect(v).toMatchObject({ stage: "planned", next: { action: "start", requestId: A } });
  });

  it("7 and 8. boarding and drop-off target the right rider at the right stop only, and never another rider", () => {
    const { rec, run, A, B, tick } = sharedTrip();
    run((s) => engineStart(s, A));
    let snap = rec.snapshot();
    expect(view(snap)).toMatchObject({ stage: "to_stop", actions: [] }); // still at a, heading to b
    // Being assigned does not mean on board.
    expect(view(snap).shared!.riders.map((r) => r.state)).toEqual(["waiting", "waiting"]);
    tick(10);
    expect(actionsOf(rec.snapshot())).toEqual([`board ${A}`]); // at b: only Lina boards
    run((s) => engineBoard(s, A));
    tick(10);
    snap = rec.snapshot();
    expect(actionsOf(snap)).toEqual([`board ${B}`]); // at c: only Omar
    expect(view(snap).shared!.riders.map((r) => r.state)).toEqual(["on_board", "waiting"]);
    run((s) => engineBoard(s, B));
    tick(10);
    expect(actionsOf(rec.snapshot())).toEqual([`drop-off ${A}`]); // at d: only Lina leaves
  });

  it("9. one rider's drop-off completes that ride only; the trip and the other rider carry on", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = createRealtimeStore({ socket: io(live.url, { transports: ["websocket"], forceNew: true, autoConnect: false, reconnection: false }), fetchSnapshot: () => fetch(`${live.url}/api/snapshot`).then((r) => r.json()) });
    stores.push(store);
    store.start();
    await waitFor(store, "first snapshot", (s) => s.status === "live" && s.data !== null);
    const post = (url: string, payload: object = {}) => live.app.inject({ method: "POST", url, payload });
    const A = (await post("/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" })).json().id as string;
    await post(`/api/ride-requests/${A}/dispatch`);
    const B = (await post("/api/ride-requests", { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" })).json().id as string;
    await post(`/api/ride-requests/${B}/dispatch`);

    const urls: string[] = [];
    const api: DriverApi = createDriverApi(live.url, (input, init) => { urls.push(String(input)); return fetch(input, init); });
    const actions = createDriverActionController({ api, currentData: () => store.getState().data, resync: () => store.resync() });
    const sync = (what: string, ok: (d: StateSnapshot) => boolean) => waitFor(store, what, (s) => s.data !== null && ok(s.data));
    const step = async (want: string, advanceSeconds = 0) => {
      if (advanceSeconds) await post("/api/simulation/advance", { seconds: advanceSeconds });
      const d = await sync(want, (x) => actionsOf(x)[0] === want);
      const binding = view(d.data!).actions[0]!;
      expect(await actions.submit(binding)).toBe("sent");
    };

    await sync("join", (d) => d.trips[0]?.passengers.length === 2);
    await step(`start ${A}`);
    await step(`board ${A}`, 10);
    await step(`board ${B}`, 10);
    await step(`drop-off ${A}`, 10);
    const afterOne = await sync("Lina completed", (d) => d.requests.find((r) => r.id === A)?.status === "completed");
    const t = afterOne.data!.trips[0]!;
    expect(t.status).toBe("active");
    expect(view(afterOne.data!).shared!.riders.map((r) => r.state)).toEqual(["dropped_off", "on_board"]);
    expect(afterOne.data!.requests.find((r) => r.id === B)!.status).toBe("on_board");
    expect(afterOne.data!.carts.find((c) => c.id === "CART-01")).toMatchObject({ status: "occupied", passengerCount: 1 });
    await step(`drop-off ${B}`, 10);
    const done = await sync("trip completed", (d) => d.trips[0]?.status === "completed");
    expect(openTripsForCart(done.data!, "CART-01")).toEqual([]);
    expect(urls.map((u) => u.replace(live.url, ""))).toEqual([
      `/api/ride-requests/${A}/start`, `/api/ride-requests/${A}/board`, `/api/ride-requests/${B}/board`,
      `/api/ride-requests/${A}/drop-off`, `/api/ride-requests/${B}/drop-off`,
    ]);
  });

  it("10. a refused or stale action never produces a success, and nothing is changed locally", async () => {
    const { rec, run, A, B, tick } = sharedTrip();
    run((s) => engineStart(s, A));
    tick(10);
    const snap = rec.snapshot();
    // Omar's pickup is a later stop: a binding for him is not offered, so it is refused before sending.
    const notOffered: ActionBinding = { action: "board", requestId: B, tripId: "TRIP-0001", expectedStatus: "arriving" };
    expect(bindingStillValid(snap, notOffered)).toBe(false);
    let calls = 0;
    const refusing: DriverApi = { rideAction: async () => { calls += 1; return { ok: false, status: 409, code: "NOT_AT_STOP", message: 'CART-01 is serving earlier stops before the pickup "c"' }; } };
    const ctl = createDriverActionController({ api: refusing, currentData: () => snap, resync: () => {} });
    expect(await ctl.submit(notOffered)).toBe("stale");
    expect(calls).toBe(0);
    expect(ctl.getState()).toMatchObject({ status: "error", code: "STALE_STATE" });
    // An offered action the server then refuses: the error is shown, no success, the live state untouched.
    const offered = view(snap).actions[0]!;
    expect(await ctl.submit(offered)).toBe("failed");
    expect(calls).toBe(1);
    expect(ctl.getState()).toMatchObject({ status: "error", code: "NOT_AT_STOP" });
    expect(view(snap).shared!.riders.map((r) => r.state)).toEqual(["waiting", "waiting"]);
  });

  it("Stage 4 stays off in the UI: no driver action ever adds a rider", () => {
    const { rec, run, A, tick } = sharedTrip();
    const seen = new Set<string>();
    const collect = () => view(rec.snapshot()).actions.forEach((a) => seen.add(a.action));
    collect(); run((s) => engineStart(s, A)); collect(); tick(10); collect(); run((s) => engineBoard(s, A)); collect();
    expect([...seen].sort()).toEqual(["board", "start"]);
  });

  it("13. a solo trip keeps the Phase 3 view: no shared view, one next step", () => {
    const e = engine();
    const id = e.book("stu-lina", "c", "e");
    e.dispatch(id);
    const v = view(e.rec.snapshot());
    expect(isSharedTrip(e.rec.snapshot(), v.trip)).toBe(false);
    expect(v).toMatchObject({ shared: null, stage: "planned", request: { id }, next: { action: "start", requestId: id } });
    expect(v.actions).toEqual([v.next]);
    expect(tripView(e.rec.snapshot(), v.trip)).toEqual(v);
  });
});

// ---------- Realtime: duplicates and stale updates ----------

describe("realtime store with shared trips", () => {
  it("11 and 12. duplicate and stale updates neither duplicate riders nor roll back newer state", () => {
    const { rec, run, A } = sharedTrip();
    const socket = new FakeSocket();
    const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
    stores.push(store);
    store.start();
    socket.serverConnect(rec.snapshot());
    const n = rec.updates.length;
    run((s) => engineStart(s, A));
    const startUpdate = rec.updates[n]!;
    socket.emit("state:update", structuredClone(startUpdate));
    socket.emit("state:update", structuredClone(startUpdate)); // duplicate
    let data = store.getState().data!;
    expect(data.trips).toHaveLength(1);
    expect(data.trips[0]!.passengers.map((p) => p.requestId)).toEqual([A, "REQ-0002"]);
    expect(studentRides(data, "stu-lina")).toHaveLength(1);
    expect(data.trips[0]!.status).toBe("active");
    // An older revision (the join, before the start) arrives late: ignored.
    socket.emit("state:update", structuredClone(rec.updates[n - 1]!));
    data = store.getState().data!;
    expect(data.revision).toBe(startUpdate.revision);
    expect(data.trips[0]!.status).toBe("active");
    expect(data.requests.map((r) => r.status)).toEqual(["arriving", "arriving"]);
  });
});

// ---------- Operations ----------

describe("Operations dispatch visibility", () => {
  it("shows the server's joined outcome and every open trip it checked, without re-ranking", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const post = (url: string, payload: object = {}) => live.app.inject({ method: "POST", url, payload });
    const A = (await post("/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" })).json().id as string;
    const B = (await post("/api/ride-requests", { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" })).json().id as string;
    const snapshot = async () => (await (await fetch(`${live.url}/api/snapshot`)).json()) as StateSnapshot;
    let current = await snapshot();
    const withData = createDispatchController({ api: createOpsApi(live.url), currentData: () => current, resync: () => {} });
    expect(await withData.submit(A)).toBe("sent");
    expect(withData.getState()).toMatchObject({ status: "success", result: { selection: { mode: "shared", outcome: "new_cart", selectedCartId: "CART-01", joinCandidates: [] } } });
    current = await snapshot();
    expect(await withData.submit(B)).toBe("sent");
    const s = withData.getState();
    if (s.status !== "success") throw new Error("expected success");
    expect(s.result.selection).toMatchObject({ outcome: "joined", selectedTripId: "TRIP-0001", maxAddedDelaySeconds: 240, joinCandidates: [{ tripId: "TRIP-0001", eligible: true, rank: 1, stage: "planned", stopLocationIds: ["b", "c", "d", "e"] }] });
    expect(s.result.selection.joinCandidates![0]!.riders!.map((r) => [r.requestId, r.joining])).toEqual([[A, false], [B, true]]);
    const trip = (await snapshot()).trips[0]!;
    expect(tripRiderCounts(trip)).toEqual({ committed: 2, onBoard: 0, total: 2 });
  });

  it("a refused shared dispatch shows the server's per-trip exclusion code, explained in plain words", async () => {
    const live = await liveApp(apps, lineCampus(), [cartAt("CART-01", "a")]);
    const post = (url: string, payload: object = {}) => live.app.inject({ method: "POST", url, payload });
    const A = (await post("/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" })).json().id as string;
    await post(`/api/ride-requests/${A}/dispatch`);
    const B = (await post("/api/ride-requests", { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" })).json().id as string;
    const snap = (await (await fetch(`${live.url}/api/snapshot`)).json()) as StateSnapshot;
    const ctl = createDispatchController({ api: createOpsApi(live.url), currentData: () => snap, resync: () => {} });
    expect(await ctl.submit(B)).toBe("failed");
    const s = ctl.getState();
    if (s.status !== "error") throw new Error("expected error");
    expect(s.code).toBe("NO_CART_AVAILABLE");
    expect(s.selection).toMatchObject({ outcome: null, joinCandidates: [{ tripId: "TRIP-0001", eligible: false, excludedCode: "SOLO_BASELINE_UNAVAILABLE" }] });
    expect(JOIN_EXCLUSION_TEXT[s.selection!.joinCandidates![0]!.excludedCode!]).toMatch(/No cart could take this ride alone/);
  });

  it("every exclusion code the server can send has a plain-language text", () => {
    for (const code of ["SOLO_BASELINE_UNAVAILABLE", "TRIP_NOT_JOINABLE", "STAGE_NOT_ALLOWED", "TRIP_NOT_SHARED", "CART_INELIGIBLE", "SAME_STUDENT", "TRIP_FULL", "RIDER_BASELINE_MISSING", "ROUTE_METRIC_UNAVAILABLE", "DELAY_CAP_EXCEEDED"]) {
      expect(JOIN_EXCLUSION_TEXT[code], code).toBeTruthy();
    }
  });
});
