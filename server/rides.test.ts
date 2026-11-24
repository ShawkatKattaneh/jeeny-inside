/**
 * Phase 2 Prompt 2: dispatch and ride execution through the real Fastify app (inject) and the real
 * engine (dispatch, lifecycle, simulation). Nothing in the engine, the dispatch policy or the store is
 * mocked. The line campus (engine/testRideFixtures.ts) is a - b - c - d - e with 100 m paths at
 * 36 km/h, so a 36 km/h cart needs exactly 10 s per path.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CampusConfig, Cart, RideRequest, Trip, type CartInput } from "../shared/schemas";
import { createFleet, type Fleet } from "../engine/fleet";
import { checkRideInvariants, createRequest, type RideState } from "../engine/rides";
import { DISPATCH_POLICY, dispatchRequest } from "../engine/dispatch";
import { advance } from "../engine/simulation";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { loadCampus } from "./campus";
import { loadFleet } from "./fleet";
import { createAppStore, type AppStore } from "./state";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function fleetFor(campus: CampusConfig, carts: CartInput[]): Fleet {
  const f = createFleet(campus, carts);
  if (!f.ok) throw new Error(f.errors.map((e) => e.message).join("\n"));
  return f.fleet;
}

/** An app on the line campus with these carts, plus its store so tests can check engine invariants. */
async function lineApp(carts: CartInput[], campus = lineCampus()): Promise<{ app: FastifyInstance; store: AppStore }> {
  const store = createAppStore(campus, fleetFor(campus, carts));
  const app = await buildApp({ store });
  apps.push(app);
  return { app, store };
}

const json = (app: FastifyInstance, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });

async function request(app: FastifyInstance, pickupId: string, destinationId: string, studentId = "stu-lina"): Promise<string> {
  const res = await json(app, "POST", "/api/ride-requests", { studentId, pickupId, destinationId });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}
const act = (app: FastifyInstance, id: string, action: string, payload?: unknown) => json(app, "POST", `/api/ride-requests/${id}/${action}`, payload);
const advanceBy = (app: FastifyInstance, seconds: unknown) => json(app, "POST", "/api/simulation/advance", { seconds });
const cartOf = async (app: FastifyInstance, id = "CART-01") => (await json(app, "GET", `/api/carts/${id}`)).json();
const reqOf = async (app: FastifyInstance, id: string) => (await json(app, "GET", `/api/ride-requests/${id}`)).json();
const tripOf = async (app: FastifyInstance, id: string) => (await json(app, "GET", `/api/ride-requests/${id}/trip`)).json().trip;

/** Everything the API exposes about the state, for "nothing changed" checks. */
async function dump(app: FastifyInstance, ids: string[]) {
  const parts = [await json(app, "GET", "/api/carts")];
  for (const id of ids) parts.push(await json(app, "GET", `/api/ride-requests/${id}`), await json(app, "GET", `/api/ride-requests/${id}/trip`));
  return parts.map((p) => `${p.statusCode} ${p.body}`).join("\n");
}

/** The exact stored state object, read without copying (an apply that always fails). */
function storedState(store: AppStore): RideState {
  let seen: RideState | undefined;
  store.apply((s) => { seen = s; return { ok: false as const, error: { code: "PEEK", message: "read only" } }; });
  return seen!;
}

const invariantsHold = (store: AppStore) => expect(checkRideInvariants(storedState(store))).toEqual([]);

// ---------- Dispatch selection (1-11) ----------

describe("dispatch selection", () => {
  it("assigns the one eligible cart and explains the choice", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a")]);
    const id = await request(app, "c", "e");
    const res = await act(app, id, "dispatch");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(RideRequest.safeParse(body.request).success).toBe(true);
    expect(Trip.safeParse(body.trip).success).toBe(true);
    expect(Cart.safeParse(body.cart).success).toBe(true);
    expect(body.request).toMatchObject({ id, status: "assigned" });
    expect(body.trip).toMatchObject({ id: "TRIP-0001", cartId: "CART-01", status: "planned", leg: null });
    expect(body.cart).toMatchObject({ id: "CART-01", status: "assigned", position: { kind: "at", locationId: "a" } });
    expect(body.selection).toEqual({
      policy: DISPATCH_POLICY,
      selectedCartId: "CART-01",
      candidates: [{ cartId: "CART-01", eligible: true, pickupEtaSeconds: 20, pickupDistanceMeters: 200, rank: 1 }],
    });
    // The API reflects the same assignment.
    expect(await reqOf(app, id)).toMatchObject({ status: "assigned" });
    expect(await tripOf(app, id)).toMatchObject({ id: "TRIP-0001", cartId: "CART-01" });
    invariantsHold(store);
  });

  it("picks the cart with the lowest time to the pickup", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "b"), cartAt("CART-03", "e")]);
    const id = await request(app, "c", "e");
    const { selection, trip } = (await act(app, id, "dispatch")).json();
    expect(trip.cartId).toBe("CART-02");
    expect(selection.candidates).toEqual([
      { cartId: "CART-01", eligible: true, pickupEtaSeconds: 20, pickupDistanceMeters: 200, rank: 2 },
      { cartId: "CART-02", eligible: true, pickupEtaSeconds: 10, pickupDistanceMeters: 100, rank: 1 },
      { cartId: "CART-03", eligible: true, pickupEtaSeconds: 20, pickupDistanceMeters: 200, rank: 3 }, // ties CART-01; loses on id
    ]);
  });

  it("uses exact time, not distance, first: a slower nearby cart loses to a faster cart further away", async () => {
    // CART-01 is 100 m away at 9 km/h (40 s); CART-02 is 200 m away at 36 km/h (20 s).
    const { app } = await lineApp([cartAt("CART-01", "b", { maxSpeedKmh: 9 }), cartAt("CART-02", "a")]);
    const id = await request(app, "c", "e");
    const { selection } = (await act(app, id, "dispatch")).json();
    expect(selection.selectedCartId).toBe("CART-02");
    expect(selection.candidates.map((c: { pickupEtaSeconds: number }) => c.pickupEtaSeconds)).toEqual([40, 20]);
  });

  it("breaks an exact time tie on the shorter route distance", async () => {
    // p is the pickup. CART-02 is 50 m away at 18 km/h, CART-01 is 100 m away at 36 km/h: both exactly 10 s.
    const campus = CampusConfig.parse({
      id: "tie", name: "Tie", fictional: true, map: { width: 300, height: 100 },
      locations: ["a", "p", "b", "q"].map((id, i) => ({ id, name: id, type: "pickup", position: { x: 20 + i * 60, y: 50 }, canStop: true })),
      paths: [
        { id: "ap", from: "a", to: "p", lengthMeters: 50, speedKmh: 36 },
        { id: "pb", from: "p", to: "b", lengthMeters: 100, speedKmh: 36 },
        { id: "pq", from: "p", to: "q", lengthMeters: 100, speedKmh: 36 },
      ],
    });
    const { app } = await lineApp([cartAt("CART-01", "b"), cartAt("CART-02", "a", { maxSpeedKmh: 18 })], campus);
    const id = await request(app, "p", "q");
    const { selection } = (await act(app, id, "dispatch")).json();
    expect(selection.candidates).toEqual([
      { cartId: "CART-01", eligible: true, pickupEtaSeconds: 10, pickupDistanceMeters: 100, rank: 2 },
      { cartId: "CART-02", eligible: true, pickupEtaSeconds: 10, pickupDistanceMeters: 50, rank: 1 },
    ]);
    expect(selection.selectedCartId).toBe("CART-02");
  });

  it("breaks a full tie on cart id, whatever order the fleet file lists the carts in", async () => {
    const { app } = await lineApp([cartAt("CART-03", "a"), cartAt("CART-02", "a"), cartAt("CART-01", "a")]);
    const id = await request(app, "c", "e");
    const { selection } = (await act(app, id, "dispatch")).json();
    expect(selection.selectedCartId).toBe("CART-01");
    expect(selection.candidates.map((c: { cartId: string; rank: number }) => [c.cartId, c.rank])).toEqual([["CART-01", 1], ["CART-02", 2], ["CART-03", 3]]);
  });

  it("the same result even when the fleet's Map iterates in a different order", () => {
    const campus = lineCampus();
    const fleet = fleetFor(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "a"), cartAt("CART-03", "e")]);
    const reversed: Fleet = { ...fleet, carts: new Map([...fleet.carts].reverse()) };
    expect([...reversed.carts.keys()]).toEqual(["CART-03", "CART-02", "CART-01"]);
    const pick = (f: Fleet) => {
      const store = createAppStore(campus, f);
      store.apply((s) => createRequest(s, { studentId: "s", pickupId: "c", destinationId: "e" }));
      const r = store.apply((s) => dispatchRequest(s, "REQ-0001"));
      if (!r.ok) throw new Error(r.error.message);
      return { cart: r.trip.cartId, selection: r.selection };
    };
    expect(pick(reversed)).toEqual(pick(fleet));
    expect(pick(reversed).cart).toBe("CART-01");
  });

  it("excludes charging, offline, maintenance and below-reserve carts, with the engine's reasons; exactly 15% passes", async () => {
    const { app } = await lineApp([
      cartAt("CART-01", "b", { status: "charging" }),
      cartAt("CART-02", "b", { status: "offline" }),
      cartAt("CART-03", "b", { status: "maintenance" }),
      cartAt("CART-04", "b", { batteryPercent: 14.9 }),
      cartAt("CART-05", "a", { batteryPercent: 15 }),
    ]);
    const id = await request(app, "c", "e");
    const { selection } = (await act(app, id, "dispatch")).json();
    const byId = Object.fromEntries(selection.candidates.map((c: { cartId: string }) => [c.cartId, c]));
    expect(byId["CART-01"]).toMatchObject({ eligible: false, excludedCode: "CART_INELIGIBLE", excludedReason: "CART-01 is charging and not available" });
    expect(byId["CART-02"]).toMatchObject({ eligible: false, excludedCode: "CART_INELIGIBLE", excludedReason: "CART-02 is offline and not available" });
    expect(byId["CART-03"]).toMatchObject({ eligible: false, excludedCode: "CART_INELIGIBLE", excludedReason: "CART-03 is maintenance and not available" });
    expect(byId["CART-04"]).toMatchObject({ eligible: false, excludedCode: "CART_INELIGIBLE", excludedReason: "CART-04 battery 14.9% is below the 15% reserve" });
    expect(byId["CART-05"]).toMatchObject({ eligible: true, rank: 1 });
    expect(selection.selectedCartId).toBe("CART-05");
    for (const c of selection.candidates.filter((c: { eligible: boolean }) => !c.eligible)) {
      expect(c).not.toHaveProperty("pickupEtaSeconds");
      expect(c).not.toHaveProperty("rank");
    }
  });

  it("a full cart (1 seat, passenger on board) and a cart on a path are never candidates (D10: no assignment mid-path)", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a", { seats: 1 }), cartAt("CART-02", "b"), cartAt("CART-03", "e")]);
    // CART-01 takes a ride and boards its passenger: full.
    const first = await request(app, "a", "b");
    expect((await act(app, first, "dispatch")).json().trip.cartId).toBe("CART-01");
    await act(app, first, "start");
    expect((await act(app, first, "board")).statusCode).toBe(200);
    // CART-02 takes a ride and is moving along a path.
    const second = await request(app, "c", "d");
    expect((await act(app, second, "dispatch")).json().trip.cartId).toBe("CART-02");
    await act(app, second, "start");
    await advanceBy(app, 5);
    expect((await cartOf(app, "CART-02")).position).toEqual({ kind: "on_path", pathId: "bc", progress: 0.5 });
    expect((await cartOf(app, "CART-01")).position).toEqual({ kind: "on_path", pathId: "ab", progress: 0.5 });

    const third = await request(app, "b", "c");
    const { selection } = (await act(app, third, "dispatch")).json();
    expect(selection.candidates.slice(0, 2)).toEqual([
      { cartId: "CART-01", eligible: false, excludedCode: "CART_ALREADY_ASSIGNED", excludedReason: "CART-01 is already on trip TRIP-0001" },
      { cartId: "CART-02", eligible: false, excludedCode: "CART_ALREADY_ASSIGNED", excludedReason: "CART-02 is already on trip TRIP-0002" },
    ]);
    expect(selection.selectedCartId).toBe("CART-03");
  });

  it("no eligible cart: 409 NO_CART_AVAILABLE with every reason, the request stays requested, nothing changes", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a", { status: "charging" }), cartAt("CART-02", "b", { batteryPercent: 3 })]);
    const id = await request(app, "c", "e");
    const before = await dump(app, [id]);
    const state = storedState(store);
    const res = await act(app, id, "dispatch");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: `No cart can take ${id} right now; it stays requested`,
      code: "NO_CART_AVAILABLE",
      selection: {
        policy: DISPATCH_POLICY,
        selectedCartId: null,
        candidates: [
          { cartId: "CART-01", eligible: false, excludedCode: "CART_INELIGIBLE", excludedReason: "CART-01 is charging and not available" },
          { cartId: "CART-02", eligible: false, excludedCode: "CART_INELIGIBLE", excludedReason: "CART-02 battery 3% is below the 15% reserve" },
        ],
      },
    });
    expect(await dump(app, [id])).toBe(before);
    expect(storedState(store)).toBe(state);
    expect(await reqOf(app, id)).toMatchObject({ status: "requested" });
  });

  it("unknown request: 404; already assigned or finished: 409, state unchanged", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "a")]);
    for (const bad of ["REQ-0001", "nope"]) {
      const res = await act(app, bad, "dispatch");
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("UNKNOWN_REQUEST");
    }
    const id = await request(app, "c", "e");
    expect((await act(app, id, "dispatch")).statusCode).toBe(200);
    const state = storedState(store);
    const again = await act(app, id, "dispatch");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: `${id} is assigned; only a requested ride can be assigned`, code: "INVALID_TRANSITION" });
    expect(storedState(store)).toBe(state);
    expect((await cartOf(app, "CART-02")).status).toBe("idle");

    const cancelled = await request(app, "c", "e");
    await act(app, cancelled, "cancel");
    expect((await act(app, cancelled, "dispatch")).json().code).toBe("RIDE_FINISHED");
  });

  it("two requests can never reserve the same cart; each dispatch uses the latest state", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "b"), cartAt("CART-02", "e")]);
    const r1 = await request(app, "c", "d");
    const r2 = await request(app, "c", "d", "stu-omar");
    const r3 = await request(app, "a", "b", "stu-sara");
    // r1 gets the nearer CART-01; r2 then sees CART-01 taken and gets CART-02; r3 finds nothing.
    expect((await act(app, r1, "dispatch")).json().trip.cartId).toBe("CART-01");
    const second = (await act(app, r2, "dispatch")).json();
    expect(second.trip.cartId).toBe("CART-02");
    expect(second.selection.candidates[0]).toMatchObject({ cartId: "CART-01", eligible: false, excludedCode: "CART_ALREADY_ASSIGNED" });
    const third = await act(app, r3, "dispatch");
    expect(third.statusCode).toBe(409);
    expect(third.json().code).toBe("NO_CART_AVAILABLE");
    expect(await reqOf(app, r3)).toMatchObject({ status: "requested" });
    // Dispatching r1 and r2 did not touch r3, and r3's dispatch touched nothing else.
    expect(await tripOf(app, r3)).toBeNull();
    invariantsHold(store);
  });

  it("concurrent dispatch calls for different requests never share a cart", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "a"), cartAt("CART-03", "a")]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await request(app, "c", "e", `stu-${i}`));
    const results = await Promise.all(ids.map((id) => act(app, id, "dispatch")));
    const won = results.filter((r) => r.statusCode === 200).map((r) => r.json().trip.cartId).sort();
    expect(won).toEqual(["CART-01", "CART-02", "CART-03"]);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().code === "NO_CART_AVAILABLE")).toBe(true);
    invariantsHold(store);
  });

  it("repeated identical runs make identical decisions", async () => {
    const run = async () => {
      const { app } = await lineApp([cartAt("CART-02", "e"), cartAt("CART-01", "a"), cartAt("CART-03", "c", { maxSpeedKmh: 12 })]);
      const out: unknown[] = [];
      for (const [p, d] of [["b", "d"], ["d", "a"], ["c", "e"]] as const) out.push((await act(app, await request(app, p, d), "dispatch")).json());
      return JSON.stringify(out);
    };
    expect(await run()).toBe(await run());
  });

  it("the seeded campus: both carts start at the depot, so CART-01 wins on cart id", async () => {
    const campus = loadCampus();
    const app = await buildApp({ campus, fleet: loadFleet(campus) });
    apps.push(app);
    const id = await request(app, "pickup-main-plaza", "library");
    const { selection } = (await act(app, id, "dispatch")).json();
    expect(selection.selectedCartId).toBe("CART-01");
    const [one, two] = selection.candidates;
    expect(one.pickupEtaSeconds).toBe(two.pickupEtaSeconds);
    expect(one.pickupDistanceMeters).toBe(two.pickupDistanceMeters);
  });
});

// ---------- Ride execution (12-22) ----------

describe("ride execution", () => {
  it("runs a full ride: dispatch, start, drive to the pickup, board, drive, drop off", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a")]);
    const id = await request(app, "c", "e");
    await act(app, id, "dispatch");

    // Start: route to the pickup is planned; nothing moves until time advances.
    const started = (await act(app, id, "start")).json();
    expect(started.request.status).toBe("arriving");
    expect(started.trip).toMatchObject({ status: "active", stopIndex: 0, leg: { locationIds: ["a", "b", "c"], pathIds: ["ab", "bc"] } });
    expect(started.cart).toMatchObject({ status: "assigned", position: { kind: "at", locationId: "a" }, passengerCount: 0 });
    expect((await act(app, id, "start")).json().code).toBe("INVALID_TRANSITION");

    // Too early to board.
    const early = await act(app, id, "board");
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: 'CART-01 has not reached the pickup "c" yet', code: "NOT_AT_STOP" });

    let step = (await advanceBy(app, 15)).json();
    expect(step.clockSeconds).toBe(15);
    expect(step.carts[0].position).toEqual({ kind: "on_path", pathId: "bc", progress: 0.5 });
    expect((await act(app, id, "board")).json().code).toBe("NOT_AT_STOP");

    step = (await advanceBy(app, 5)).json();
    expect(step.carts[0]).toMatchObject({ position: { kind: "at", locationId: "c" }, status: "assigned", passengerCount: 0 });
    // The cart waits at the pickup: more time does not move it or board anyone.
    step = (await advanceBy(app, 30)).json();
    expect(step.clockSeconds).toBe(50);
    expect(step.carts[0]).toMatchObject({ position: { kind: "at", locationId: "c" }, status: "assigned", passengerCount: 0 });
    expect((await reqOf(app, id)).status).toBe("arriving");

    const boarded = (await act(app, id, "board")).json();
    expect(boarded.request).toMatchObject({ status: "on_board", updatedAt: 50_000 });
    expect(boarded.trip).toMatchObject({ stopIndex: 1, passengers: [{ requestId: id, boarded: true }], leg: { locationIds: ["c", "d", "e"] } });
    expect(boarded.cart).toMatchObject({ status: "occupied", passengerCount: 1, position: { kind: "at", locationId: "c" } });
    expect((await act(app, id, "board")).json().code).toBe("INVALID_TRANSITION");
    expect((await act(app, id, "drop-off")).json()).toEqual({ error: 'CART-01 has not reached the destination "e" yet', code: "NOT_AT_STOP" });

    step = (await advanceBy(app, 10)).json();
    expect(step.carts[0]).toMatchObject({ position: { kind: "at", locationId: "d" }, status: "occupied", passengerCount: 1 });
    step = (await advanceBy(app, 25)).json();
    expect(step.carts[0]).toMatchObject({ position: { kind: "at", locationId: "e" }, status: "occupied", passengerCount: 1 });
    expect(step.trips).toEqual([expect.objectContaining({ status: "active", stopIndex: 1 })]);
    expect((await reqOf(app, id)).status).toBe("on_board");

    const done = (await act(app, id, "drop-off")).json();
    expect(done.request).toMatchObject({ status: "completed" });
    expect(done.trip).toMatchObject({ status: "completed", stopIndex: 2, leg: null });
    expect(done.cart).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "e" } });
    for (const again of ["drop-off", "board", "start", "cancel"]) expect((await act(app, id, again)).json().code, again).toBe("RIDE_FINISHED");
    invariantsHold(store);

    // A finished trip is no longer moved by the simulation.
    expect((await advanceBy(app, 10)).json()).toMatchObject({ clockSeconds: 95, trips: [], carts: [expect.objectContaining({ position: { kind: "at", locationId: "e" } })] });
  });

  it("start, board and drop-off before dispatch are refused", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a")]);
    const id = await request(app, "c", "e");
    expect((await act(app, id, "start")).json()).toEqual({ error: `${id} is requested; only an assigned ride can start`, code: "INVALID_TRANSITION" });
    expect((await act(app, id, "board")).json().code).toBe("INVALID_TRANSITION");
    expect((await act(app, id, "drop-off")).json().code).toBe("INVALID_TRANSITION");
  });

  it("failed lifecycle calls leave the exact same stored state", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a")]);
    const id = await request(app, "c", "e");
    await act(app, id, "dispatch");
    await act(app, id, "start");
    await advanceBy(app, 5);
    const state = storedState(store);
    const before = await dump(app, [id]);
    const calls: [string, unknown][] = [["board", undefined], ["drop-off", undefined], ["start", undefined], ["dispatch", undefined], ["board", { cartId: "CART-01" }], ["cancel", { force: true }]];
    for (const [action, payload] of calls) expect((await act(app, id, action, payload)).statusCode, action).toBeGreaterThanOrEqual(400);
    for (const bad of [0, -1, 601, "5", null]) expect((await advanceBy(app, bad)).statusCode).toBe(400);
    expect(storedState(store)).toBe(state);
    expect(await dump(app, [id])).toBe(before);
  });

  it("lifecycle calls refuse any body fields, so a client cannot pick a cart or set internal values", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "c")]);
    const id = await request(app, "c", "e");
    for (const payload of [{ cartId: "CART-01" }, { status: "assigned" }, { passengerCount: 1 }, { position: { kind: "at", locationId: "c" } }, []]) {
      const res = await act(app, id, "dispatch", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe("INVALID_REQUEST");
    }
    // An empty JSON object is fine; the policy still picks CART-02 (already at the pickup).
    const ok = await act(app, id, "dispatch", {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json().trip.cartId).toBe("CART-02");
  });

  it("every action returns 404 for an unknown request", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a")]);
    for (const action of ["dispatch", "start", "board", "drop-off", "cancel"]) {
      const res = await act(app, "REQ-0404", action);
      expect(res.statusCode, action).toBe(404);
      expect(res.json()).toEqual({ error: 'No ride request with id "REQ-0404"', code: "UNKNOWN_REQUEST" });
    }
  });
});

// ---------- Cancellation (8, 18, 19, 32) ----------

describe("cancellation", () => {
  it("cancels a requested ride with no cart involved", async () => {
    const { app } = await lineApp([cartAt("CART-01", "a")]);
    const id = await request(app, "c", "e");
    const res = (await act(app, id, "cancel")).json();
    expect(res).toMatchObject({ request: { status: "cancelled" }, trip: null, cart: null });
    expect((await cartOf(app)).status).toBe("idle");
    expect((await act(app, id, "cancel")).json().code).toBe("RIDE_FINISHED");
  });

  it("cancels an assigned ride, and an arriving ride whose cart is still at a location: the cart is free again where it is", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a")]);
    const assigned = await request(app, "c", "e");
    await act(app, assigned, "dispatch");
    expect((await act(app, assigned, "cancel")).json()).toMatchObject({ request: { status: "cancelled" }, trip: { status: "cancelled" }, cart: { status: "idle", position: { kind: "at", locationId: "a" } } });

    const arriving = await request(app, "c", "e");
    await act(app, arriving, "dispatch");
    await act(app, arriving, "start");
    await advanceBy(app, 10); // exactly at b, an intermediate location
    expect((await cartOf(app)).position).toEqual({ kind: "at", locationId: "b" });
    expect((await act(app, arriving, "cancel")).json()).toMatchObject({ trip: { status: "cancelled", leg: null }, cart: { status: "idle", position: { kind: "at", locationId: "b" } } });
    invariantsHold(store);
  });

  it("mid-path cancel: the cart finishes only its current path, cannot be reassigned until then, then is free", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a")]);
    const id = await request(app, "d", "e");
    await act(app, id, "dispatch");
    await act(app, id, "start");
    await advanceBy(app, 14); // 40% along bc
    const cancelled = (await act(app, id, "cancel")).json();
    expect(cancelled.request.status).toBe("cancelled");
    expect(cancelled.trip).toMatchObject({ status: "cancelling", leg: { locationIds: ["b", "c"], pathIds: ["bc"] } });
    expect(cancelled.cart).toMatchObject({ status: "assigned", position: { kind: "on_path", pathId: "bc" } });
    expect(cancelled.cart.position.progress).toBeCloseTo(0.4, 12);
    expect((await act(app, id, "cancel")).json().code).toBe("ALREADY_CANCELLING");

    // A new ride cannot take the cart during cleanup.
    const next = await request(app, "a", "b");
    const during = await act(app, next, "dispatch");
    expect(during.statusCode).toBe(409);
    expect(during.json().code).toBe("NO_CART_AVAILABLE");
    expect(during.json().selection.candidates[0]).toMatchObject({ excludedCode: "CART_ALREADY_ASSIGNED", excludedReason: "CART-01 is already on trip TRIP-0001, finishing its path after a cancellation" });
    expect((await reqOf(app, next)).status).toBe("requested");

    // Cleanup: 6 s finishes bc (60 m at 10 m/s). The cart stops at c, not at the old pickup d.
    let step = (await advanceBy(app, 3)).json();
    expect(step.trips[0].status).toBe("cancelling");
    expect(step.carts[0].status).toBe("assigned");
    step = (await advanceBy(app, 50)).json();
    expect(step.trips).toEqual([expect.objectContaining({ id: "TRIP-0001", status: "cancelled", leg: null })]);
    expect(step.carts[0]).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "c" } });
    expect((await act(app, id, "cancel")).json().code).toBe("RIDE_FINISHED");

    // Now the engine allows reassignment, from where the cart really is.
    const after = (await act(app, next, "dispatch")).json();
    expect(after.trip).toMatchObject({ id: "TRIP-0002", cartId: "CART-01" });
    expect(after.selection.candidates[0]).toMatchObject({ eligible: true, pickupDistanceMeters: 200 });
    invariantsHold(store);
  });

  it("a ride cannot be cancelled after boarding", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "c")]);
    const id = await request(app, "c", "e");
    await act(app, id, "dispatch");
    await act(app, id, "start");
    await act(app, id, "board");
    await advanceBy(app, 5);
    const state = storedState(store);
    const res = await act(app, id, "cancel");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: `${id} cannot be cancelled after boarding; the ride must be completed with a drop-off`, code: "CANNOT_CANCEL_ON_BOARD" });
    expect(storedState(store)).toBe(state);
  });
});

// ---------- Simulation and multiple rides (20, 23-28) ----------

describe("simulation advance", () => {
  it("accepts only a positive finite number of seconds up to the documented maximum", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a")]);
    const state = storedState(store);
    const bad: unknown[] = [{}, { seconds: 0 }, { seconds: -5 }, { seconds: "10" }, { seconds: null }, { seconds: 601 }, { seconds: 10, clockSeconds: 0 }, { seconds: 10, carts: [] }, [10]];
    for (const payload of bad) {
      const res = await json(app, "POST", "/api/simulation/advance", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe("INVALID_REQUEST");
    }
    const huge = await app.inject({ method: "POST", url: "/api/simulation/advance", headers: { "content-type": "application/json" }, payload: '{"seconds":1e999}' });
    expect(huge.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/simulation/advance" })).statusCode).toBe(400);
    expect(storedState(store)).toBe(state);
    expect((await advanceBy(app, 600)).json()).toMatchObject({ clockSeconds: 600, trips: [] });
    expect((await advanceBy(app, 0.5)).json().clockSeconds).toBe(600.5);
  });

  it("moves every active trip in the same step, each by its own speed", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e", { maxSpeedKmh: 18 })]);
    const r1 = await request(app, "c", "d");
    const r2 = await request(app, "b", "a", "stu-omar");
    expect((await act(app, r1, "dispatch")).json().trip.cartId).toBe("CART-01");
    expect((await act(app, r2, "dispatch")).json().trip.cartId).toBe("CART-02");
    await act(app, r1, "start");
    await act(app, r2, "start");
    const step = (await advanceBy(app, 10)).json();
    expect(step.trips.map((t: { id: string }) => t.id)).toEqual(["TRIP-0001", "TRIP-0002"]);
    expect(step.carts).toEqual([
      expect.objectContaining({ id: "CART-01", position: { kind: "at", locationId: "b" } }),
      expect.objectContaining({ id: "CART-02", position: { kind: "on_path", pathId: "de", progress: 0.5 } }),
    ]);
    invariantsHold(store);
  });

  it("a failed multi-trip advance changes nothing, not even the trips that could have moved", async () => {
    const { app, store } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const r1 = await request(app, "c", "d");
    const r2 = await request(app, "c", "b", "stu-omar");
    await act(app, r1, "dispatch");
    await act(app, r2, "dispatch");
    await act(app, r1, "start");
    await act(app, r2, "start");
    await advanceBy(app, 5);
    const state = storedState(store);
    const before = await dump(app, [r1, r2]);
    // Failure injection: TRIP-0002's path "de" disappears from the graph, after TRIP-0001 has been moved
    // in the engine's working copy (trips advance in id order). The real `advance` must refuse it all.
    const result = store.apply((s) => {
      const paths = new Map(s.graph.paths);
      paths.delete("de");
      return advance({ ...s, graph: { ...s.graph, paths } }, 5);
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_MOVEMENT" } });
    expect(storedState(store)).toBe(state);
    expect(await dump(app, [r1, r2])).toBe(before);
    expect((await cartOf(app, "CART-01")).position).toEqual({ kind: "on_path", pathId: "ab", progress: 0.5 });
  });

  it("the same calls and elapsed time give the same state; splitting time between stops does not change the result", async () => {
    const scenario = async (steps: number[]) => {
      const { app, store } = await lineApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
      const r1 = await request(app, "c", "e");
      const r2 = await request(app, "d", "a", "stu-omar");
      await act(app, r1, "dispatch");
      await act(app, r2, "dispatch");
      await act(app, r1, "start");
      await act(app, r2, "start");
      for (const s of steps) await advanceBy(app, s);
      return { store, app, ids: [r1, r2] };
    };
    // CART-01 needs 20 s to its pickup c, CART-02 needs 10 s to d; both then wait.
    const one = await scenario([25]);
    const split = await scenario([4, 6, 7.5, 2.5, 5]);
    const again = await scenario([25]);
    const view = async (x: Awaited<ReturnType<typeof scenario>>) => dump(x.app, x.ids);
    expect(await view(split)).toBe(await view(one));
    expect(await view(again)).toBe(await view(one));
    expect(storedState(one.store).clockSeconds).toBe(25);
    expect((await cartOf(one.app, "CART-01")).position).toEqual({ kind: "at", locationId: "c" });
    expect((await cartOf(one.app, "CART-02")).position).toEqual({ kind: "at", locationId: "d" });
  });
});
