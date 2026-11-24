/**
 * Phase 4: Ghost Ride through the real Fastify app (inject) and the real store. Commit listeners see
 * exactly what Socket.IO broadcasts (`updateOf`), and every update is checked against the shared
 * StateUpdate schema. Line campus: a - b - c - d - e, 100 m paths, 10 s per path for these carts.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { StateUpdate, type CartInput } from "../shared/schemas";
import { SETTINGS } from "../shared/settings";
import { createFleet } from "../engine/fleet";
import { checkRideInvariants, type RideState } from "../engine/rides";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { updateOf } from "./realtime";
import { createAppStore, type AppStore } from "./state";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function lineApp(carts: CartInput[]) {
  const campus = lineCampus();
  const fleet = createFleet(campus, carts);
  if (!fleet.ok) throw new Error(fleet.errors.map((e) => e.message).join("; "));
  const store = createAppStore(campus, fleet.fleet);
  const app = await buildApp({ store });
  apps.push(app);
  const updates: StateUpdate[] = [];
  store.onCommit((c) => updates.push(StateUpdate.parse(updateOf(c))));
  return { app, store, updates };
}

const json = (app: FastifyInstance, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
async function create(app: FastifyInstance, studentId: string, pickupId: string, destinationId: string, mode?: string) {
  const res = await json(app, "POST", "/api/ride-requests", { studentId, pickupId, destinationId, ...(mode === undefined ? {} : { mode }) });
  expect(res.statusCode).toBe(201);
  return res.json();
}
const act = (app: FastifyInstance, id: string, action: string) => json(app, "POST", `/api/ride-requests/${id}/${action}`);
const advanceBy = (app: FastifyInstance, seconds: number) => json(app, "POST", "/api/simulation/advance", { seconds });

function storedState(store: AppStore): RideState {
  let seen: RideState | undefined;
  store.apply((s) => { seen = s; return { ok: false as const, error: { code: "PEEK", message: "read only" } }; });
  return seen!;
}
const invariantsHold = (store: AppStore) => expect(checkRideInvariants(storedState(store))).toEqual([]);

describe("REST: shared requests", () => {
  it("creates a shared request with mode 'shared'; mode is optional and defaults to solo", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a")]);
    expect(await create(app, "stu-lina", "b", "d", "shared")).toMatchObject({ mode: "shared", status: "requested", fareJod: SETTINGS.sharedFareJod, freeLoyaltyRide: false });
    expect(await create(app, "stu-omar", "b", "d")).toMatchObject({ mode: "solo", fareJod: SETTINGS.fareJod });
    expect(await create(app, "stu-sara", "b", "d", "solo")).toMatchObject({ mode: "solo" });
    for (const mode of ["pooled", "", "SHARED"]) {
      const res = await json(app, "POST", "/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode });
      expect(res.statusCode, mode).toBe(400);
    }
  });

  it("dispatch joins a shared request to an open trip and explains every trip it looked at", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = await create(app, "stu-lina", "b", "d", "shared");
    const first = (await act(app, a.id, "dispatch")).json();
    expect(first.selection).toMatchObject({ mode: "shared", outcome: "new_cart", selectedCartId: "CART-01", joinCandidates: [] });
    const b = await create(app, "stu-omar", "c", "e", "shared");
    const res = await act(app, b.id, "dispatch");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.request).toMatchObject({ id: b.id, status: "assigned" });
    expect(body.trip).toMatchObject({ id: first.trip.id, cartId: "CART-01", status: "planned", drivenSeconds: 0, stops: [{ locationId: "b" }, { locationId: "c" }, { locationId: "d" }, { locationId: "e" }] });
    expect(body.trip.passengers.map((p: { requestId: string }) => p.requestId)).toEqual([a.id, b.id]);
    expect(body.trip.passengers[1].baseline).toEqual({ soloPickupSeconds: 20, soloRideSeconds: 20, pickupMark: 20, dropOffMark: 40, cartId: "CART-02", recordedAtClock: 0 });
    expect(body.cart).toMatchObject({ id: "CART-01", status: "assigned" });
    expect(body.selection).toMatchObject({ outcome: "joined", selectedTripId: first.trip.id, maxAddedDelaySeconds: 240, delayEpsilonSeconds: 1e-9, joinCandidates: [{ tripId: first.trip.id, eligible: true, rank: 1 }] });
    expect((await json(app, "GET", `/api/ride-requests/${b.id}/trip`)).json().trip.id).toBe(first.trip.id);
    invariantsHold(store);
  });

  it("a refused shared dispatch is 409 with the reason per trip, and changes nothing", async () => {
    const { app, store, updates } = await lineApp([cartAt("CART-01", "a")]);
    const a = await create(app, "stu-lina", "b", "d", "shared");
    await act(app, a.id, "dispatch");
    const b = await create(app, "stu-omar", "c", "e", "shared");
    const before = updates.length;
    const snap = JSON.stringify(storedState(store));
    const res = await act(app, b.id, "dispatch");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_CART_AVAILABLE", selection: { soloBaseline: null, joinCandidates: [{ eligible: false, excludedCode: "SOLO_BASELINE_UNAVAILABLE" }] } });
    expect(updates.length).toBe(before); // zero revisions on failure
    expect(JSON.stringify(storedState(store))).toBe(snap);
  });

  it("a shared rider cancels alone; the trip and the other rider carry on", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = await create(app, "stu-lina", "b", "d", "shared"); await act(app, a.id, "dispatch");
    const b = await create(app, "stu-omar", "c", "e", "shared"); await act(app, b.id, "dispatch");
    const res = (await act(app, b.id, "cancel")).json();
    expect(res.request).toMatchObject({ id: b.id, status: "cancelled" });
    expect(res.trip).toMatchObject({ status: "planned", stops: [{ locationId: "b" }, { locationId: "d" }] });
    expect((await json(app, "GET", `/api/ride-requests/${a.id}`)).json().status).toBe("assigned");
    invariantsHold(store);
  });

  it("the Phase 4 error codes are 409 with a readable message", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = await create(app, "stu-lina", "b", "d", "shared"); await act(app, a.id, "dispatch");
    const b = await create(app, "stu-omar", "c", "e", "shared"); await act(app, b.id, "dispatch");
    await act(app, a.id, "start"); await advanceBy(app, 10);
    const early = await act(app, b.id, "board"); // B's pickup comes after A's
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "NOT_AT_STOP", error: expect.stringContaining("earlier stops") });
  });
});

describe("realtime: one revision per committed operation", () => {
  it("a join is one revision carrying the joining request and the trip (the cart did not change)", async () => {
    const { app, updates } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = await create(app, "stu-lina", "b", "d", "shared"); await act(app, a.id, "dispatch");
    const b = await create(app, "stu-omar", "c", "e", "shared");
    const before = updates.length;
    await act(app, b.id, "dispatch");
    expect(updates.length).toBe(before + 1);
    const u = updates.at(-1)!;
    expect(u).toMatchObject({ revision: updates[before - 1]!.revision + 1, operation: "ride.dispatched" });
    expect(u.requests.map((r) => r.id)).toEqual([b.id]);
    expect(u.trips).toEqual([expect.objectContaining({ passengers: [expect.objectContaining({ requestId: a.id }), expect.objectContaining({ requestId: b.id, baseline: expect.any(Object) })] })]);
    expect(u.carts).toEqual([]);
  });

  it("each advance is one revision listing every moving shared trip with its drivenSeconds", async () => {
    const { app, updates } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = await create(app, "stu-lina", "b", "d", "shared"); await act(app, a.id, "dispatch");
    const b = await create(app, "stu-omar", "c", "e", "shared"); await act(app, b.id, "dispatch");
    await act(app, a.id, "start");
    const startUpdate = updates.at(-1)!;
    expect(startUpdate.requests.map((r) => [r.id, r.status])).toEqual([[a.id, "arriving"], [b.id, "arriving"]]);
    const n = updates.length;
    const step = (await advanceBy(app, 7)).json();
    expect(step.trips).toEqual([expect.objectContaining({ status: "active", drivenSeconds: 7 })]);
    expect(updates.length).toBe(n + 1);
    expect(updates.at(-1)).toMatchObject({ operation: "simulation.advanced", clockSeconds: 7, trips: [{ drivenSeconds: 7 }], carts: [{ id: "CART-01" }] });
    // Waiting at the pickup: one revision; the trip object does not change (the cart is re-sent by
    // advance as before Phase 4, at the same position).
    await advanceBy(app, 3); await advanceBy(app, 20);
    expect(updates.at(-1)).toMatchObject({ clockSeconds: 30, trips: [], carts: [{ id: "CART-01", position: { kind: "at", locationId: "b" } }] });
  });

  it("per-rider drop-off: the first rider completes in one revision while the trip stays active", async () => {
    const { app, store, updates } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = await create(app, "stu-lina", "b", "d", "shared"); await act(app, a.id, "dispatch");
    const b = await create(app, "stu-omar", "c", "e", "shared"); await act(app, b.id, "dispatch");
    await act(app, a.id, "start");
    await advanceBy(app, 10); await act(app, a.id, "board");
    await advanceBy(app, 10); await act(app, b.id, "board");
    await advanceBy(app, 10);
    const n = updates.length;
    const res = (await act(app, a.id, "drop-off")).json();
    expect(res.request.status).toBe("completed");
    expect(res.trip).toMatchObject({ status: "active", drivenSeconds: 30 });
    expect(res.cart).toMatchObject({ status: "occupied", passengerCount: 1 });
    expect(updates.length).toBe(n + 1);
    expect(updates.at(-1)!.requests.map((r) => [r.id, r.status])).toEqual([[a.id, "completed"]]);
    await advanceBy(app, 10);
    const last = (await act(app, b.id, "drop-off")).json();
    expect(last.trip).toMatchObject({ status: "completed", drivenSeconds: 40 });
    expect(last.cart).toMatchObject({ status: "idle", passengerCount: 0 });
    invariantsHold(store);
  });
});
