import { describe, expect, it } from "vitest";
import { CampusConfig } from "../shared/schemas";
import { getCart, updateCart } from "./fleet";
import { assignCart, board, cancel, checkRideInvariants, createRequest, dropOff, remainingEtaSeconds, startTrip, type RideState } from "./rides";
import { advance } from "./simulation";
import { cartAt, lineCampus, ok, setup } from "./testRideFixtures";

const campus = lineCampus();
const cart = (s: RideState, id = "CART-01") => {
  const c = getCart(s.fleet, id);
  if (!c.ok) throw new Error(c.error.message);
  return c.cart;
};

/** Create, assign and start a ride; returns the state with the cart heading to the pickup. */
function started(s: RideState, pickupId: string, destinationId: string, cartId = "CART-01") {
  const r = ok(createRequest(s, { studentId: "stu-lina", pickupId, destinationId }));
  let next = ok(assignCart(r.state, r.request.id, cartId)).state;
  next = ok(startTrip(next, r.request.id)).state;
  return { s: next, id: r.request.id, tripId: [...next.trips.values()].find((t) => t.passengers[0]!.requestId === r.request.id)!.id };
}

/** Comparable snapshot of everything that matters; progress rounded to absorb float noise. */
function snapshot(s: RideState) {
  const round = (n: number) => Math.round(n * 1e9) / 1e9;
  return JSON.stringify({
    clock: round(s.clockSeconds),
    requests: [...s.requests.values()],
    // drivenSeconds sums many small steps: rounded like progress (Phase 4).
    trips: [...s.trips.values()].map((t) => ({ ...t, drivenSeconds: round(t.drivenSeconds) })),
    carts: [...s.fleet.carts.values()].map((c) => ({ ...c, position: c.position.kind === "on_path" ? { ...c.position, progress: round(c.position.progress) } : c.position })),
  });
}

describe("advance: movement", () => {
  it("moves part of the way along a path, measuring progress from path.from (D8)", () => {
    let { s } = started(setup(campus, [cartAt("CART-01", "a")]), "c", "e");
    s = ok(advance(s, 2.5)).state; // 25 m of 100 at 10 m/s
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "ab", progress: 0.25 });
    expect(s.clockSeconds).toBe(2.5);
  });

  it("passes through intermediate locations in one long tick and stops exactly at the stop (no overshoot)", () => {
    let { s, id } = started(setup(campus, [cartAt("CART-01", "a")]), "d", "e");
    s = ok(advance(s, 25)).state; // a -> d is 300 m = 30 s, so this ends at c + 50 m
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "cd", progress: 0.5 });
    s = ok(advance(s, 1000)).state; // far more than needed: stops at d, never continues to e
    expect(cart(s).position).toEqual({ kind: "at", locationId: "d" });
    expect(s.requests.get(id)!.status).toBe("arriving");
    s = ok(advance(s, 60)).state; // waiting at the stop until boarding: does not move
    expect(cart(s).position).toEqual({ kind: "at", locationId: "d" });
  });

  it("lands exactly on an intermediate location when the time runs out there", () => {
    let { s } = started(setup(campus, [cartAt("CART-01", "a")]), "d", "e");
    s = ok(advance(s, 20)).state;
    expect(cart(s).position).toEqual({ kind: "at", locationId: "c" });
  });

  it("drives two-way paths in reverse with decreasing progress", () => {
    let { s } = started(setup(campus, [cartAt("CART-01", "e")]), "b", "a");
    s = ok(advance(s, 2.5)).state; // e -> d on "de" (from d to e), 25 m done
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "de", progress: 0.75 });
    s = ok(advance(s, 10)).state; // past d, 25 m along "cd" from d towards c
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "cd", progress: 0.75 });
    s = ok(advance(s, 100)).state;
    expect(cart(s).position).toEqual({ kind: "at", locationId: "b" });
  });

  it("respects one-way paths: takes the long way round, never against the arrow", () => {
    const ring = CampusConfig.parse({
      ...campus, locations: campus.locations.filter((l) => ["a", "b", "c"].includes(l.id)),
      paths: [
        { id: "ab", from: "a", to: "b", lengthMeters: 100, speedKmh: 36, oneWay: true },
        { id: "bc", from: "b", to: "c", lengthMeters: 100, speedKmh: 36, oneWay: true },
        { id: "ca", from: "c", to: "a", lengthMeters: 100, speedKmh: 36, oneWay: true },
      ],
    });
    let { s, tripId } = started(setup(ring, [cartAt("CART-01", "b")]), "a", "c");
    expect(s.trips.get(tripId)!.leg).toEqual({ locationIds: ["b", "c", "a"], pathIds: ["bc", "ca"] });
    expect(remainingEtaSeconds(s, tripId)).toEqual({ ok: true, seconds: 20 });
    s = ok(advance(s, 15)).state;
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "ca", progress: 0.5 });
  });

  it("uses min(cart speed, path speed) on each path", () => {
    let { s, tripId } = started(setup(campus, [cartAt("CART-01", "a", { maxSpeedKmh: 18 })]), "b", "c");
    expect(remainingEtaSeconds(s, tripId)).toEqual({ ok: true, seconds: 20 }); // 100 m at 5 m/s
    s = ok(advance(s, 10)).state;
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "ab", progress: 0.5 });
  });

  it("moves several rides in one call, each on its own cart", () => {
    const s0 = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const one = started(s0, "c", "d", "CART-01");
    const two = started(one.s, "c", "b", "CART-02");
    const s = ok(advance(two.s, 15)).state;
    expect(cart(s, "CART-01").position).toEqual({ kind: "on_path", pathId: "bc", progress: 0.5 });
    expect(cart(s, "CART-02").position).toEqual({ kind: "on_path", pathId: "cd", progress: 0.5 });
    expect(checkRideInvariants(s)).toEqual([]);
  });

  it("does not move finished rides, idle carts or planned trips", () => {
    let s0 = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const r = ok(createRequest(s0, { studentId: "s", pickupId: "b", destinationId: "c" }));
    s0 = ok(assignCart(r.state, r.request.id, "CART-01")).state; // planned, not started
    const s = ok(advance(s0, 50)).state;
    expect(cart(s, "CART-01").position).toEqual({ kind: "at", locationId: "a" });
    expect(cart(s, "CART-02").position).toEqual({ kind: "at", locationId: "e" });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses a time step of %s", (t) => {
    const s = setup(campus, []);
    expect(() => advance(s, t)).toThrow(RangeError);
  });

  it("never changes the state it was given", () => {
    const { s } = started(setup(campus, [cartAt("CART-01", "a")]), "c", "e");
    const before = snapshot(s);
    ok(advance(s, 13));
    expect(snapshot(s)).toBe(before);
  });
});

describe("determinism and tick size", () => {
  /** A scenario with movement, a stop, boarding, more movement and a mid-path cancellation on a second cart. */
  function scenario(tick: number) {
    const run = (s: RideState, seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += tick) s = ok(advance(s, Math.min(tick, seconds - t))).state;
      return s;
    };
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const one = started(s, "c", "e", "CART-01");
    const two = started(one.s, "a", "b", "CART-02");
    s = run(two.s, 25); // CART-01 reaches c at 20 s and waits there; CART-02 (e -> a) is halfway along "bc"
    s = ok(board(s, one.id)).state;
    s = ok(cancel(s, two.id)).state; // CART-02 mid-path: cleanup to the next location
    s = run(s, 12);
    return s;
  }

  it("the same calls always give the same state", () => {
    expect(snapshot(scenario(1))).toBe(snapshot(scenario(1)));
  });

  it("the same total time in different tick sizes gives the same state", () => {
    const base = snapshot(scenario(37)); // effectively one step per phase
    for (const tick of [0.1, 0.25, 1, 2.5, 5]) expect(snapshot(scenario(tick)), `tick ${tick}`).toBe(base);
    // And the scenario really exercised every case.
    const s = scenario(1);
    expect(cart(s, "CART-01")).toMatchObject({ status: "occupied", passengerCount: 1, position: { kind: "on_path", pathId: "de", progress: 0.2 } });
    expect(cart(s, "CART-02")).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "b" } });
    expect([...s.trips.values()].map((t) => t.status)).toEqual(["active", "cancelled"]);
    expect(s.clockSeconds).toBeCloseTo(37, 9);
  });
});

describe("mid-path cancellation cleanup (D3)", () => {
  /** CART-01 at a, heading to pickup d, cancelled 25 m into "bc". */
  function cancelledMidPath() {
    let { s, id, tripId } = started(setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]), "d", "e");
    s = ok(advance(s, 12.5)).state;
    const r = ok(cancel(s, id));
    return { before: s, s: r.state, id, tripId, trip: r.trip! };
  }

  it("cancels the request at once; the trip is cancelling with only the current path; the cart keeps its exact position", () => {
    const { before, s, id, trip } = cancelledMidPath();
    expect(s.requests.get(id)).toMatchObject({ status: "cancelled", updatedAt: 12_500 });
    expect(trip).toMatchObject({ status: "cancelling", stopIndex: 0, leg: { locationIds: ["b", "c"], pathIds: ["bc"] } });
    expect(cart(s)).toEqual(cart(before)); // same status, passengers and exact progress
    expect(cart(s)).toMatchObject({ status: "assigned", passengerCount: 0, position: { kind: "on_path", pathId: "bc", progress: 0.25 } });
    expect(checkRideInvariants(s)).toEqual([]);
  });

  it("finishes only the current path: stops at the next location, never continues to the pickup", () => {
    const { s: s0, tripId } = cancelledMidPath();
    expect(remainingEtaSeconds(s0, tripId)).toEqual({ ok: true, seconds: 8 }); // 75 m at 10 m/s, rounded
    let s = ok(advance(s0, 5)).state; // still cleaning up
    expect(cart(s)).toMatchObject({ status: "assigned", position: { kind: "on_path", pathId: "bc", progress: 0.75 } });
    expect(s.trips.get(tripId)!.status).toBe("cancelling");
    s = ok(advance(s, 1000)).state; // more than enough time
    expect(cart(s)).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "c" } });
    expect(s.trips.get(tripId)).toMatchObject({ status: "cancelled", leg: null });
    s = ok(advance(s, 100)).state; // and stays there
    expect(cart(s).position).toEqual({ kind: "at", locationId: "c" });
  });

  it("follows the current direction on a reversed path", () => {
    let { s, id, tripId } = started(setup(campus, [cartAt("CART-01", "e")]), "a", "b");
    s = ok(advance(s, 13)).state; // 30 m into "cd" from d towards c
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "cd", progress: 0.7 });
    s = ok(cancel(s, id)).state;
    expect(s.trips.get(tripId)!.leg).toEqual({ locationIds: ["d", "c"], pathIds: ["cd"] });
    s = ok(advance(s, 100)).state;
    expect(cart(s)).toMatchObject({ status: "idle", position: { kind: "at", locationId: "c" } });
  });

  it("the cart cannot be reassigned while cleaning up, and can be once it is idle", () => {
    const { s } = cancelledMidPath();
    const other = ok(createRequest(s, { studentId: "s", pickupId: "e", destinationId: "a" }));
    expect(assignCart(other.state, other.request.id, "CART-01")).toMatchObject({
      ok: false, error: { code: "CART_ALREADY_ASSIGNED", message: "CART-01 is already on trip TRIP-0001, finishing its path after a cancellation" },
    });
    const later = ok(advance(other.state, 10)).state;
    expect(assignCart(later, other.request.id, "CART-01").ok).toBe(true);
  });

  it("refuses lifecycle operations and status changes during cleanup", () => {
    const { s, id } = cancelledMidPath();
    expect(cancel(s, id)).toMatchObject({ ok: false, error: { code: "ALREADY_CANCELLING" } });
    for (const op of [startTrip, board, dropOff]) expect(op(s, id)).toMatchObject({ ok: false, error: { code: "RIDE_FINISHED" } });
    for (const status of ["charging", "offline", "maintenance"]) {
      expect(updateCart(s.fleet, "CART-01", { status })).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    }
  });

  it("other carts are not affected by the cleanup", () => {
    const { s } = cancelledMidPath();
    const after = ok(advance(s, 100)).state;
    expect(cart(after, "CART-02")).toEqual(cart(s, "CART-02"));
  });
});

describe("failure atomicity", () => {
  it("a missing path stops the whole advance: nothing changes, the cart is not teleported or freed", () => {
    let { s } = started(setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]), "d", "e");
    s = ok(advance(s, 12.5)).state;
    const other = started(s, "c", "a", "CART-02");
    s = ok(cancel(other.s, other.id)).state; // CART-02 at e, cancelled at a location: idle again
    const id1 = [...s.requests.keys()][0]!;
    s = ok(cancel(s, id1)).state; // CART-01 cleaning up on "bc"
    const before = snapshot(s);
    // Simulate a corrupted graph: the path the cart is on disappears.
    const paths = new Map(s.graph.paths);
    paths.delete("bc");
    const broken: RideState = { ...s, graph: { ...s.graph, paths } };
    const r = advance(broken, 5);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_MOVEMENT" } });
    if (!r.ok) expect(r.error.message).toContain('Path "bc" does not exist on this campus');
    expect(snapshot(s)).toBe(before);
    expect(cart(s)).toMatchObject({ status: "assigned", position: { kind: "on_path", pathId: "bc" } });
  });

  it("a failed operation returns an error and the caller keeps the old state", () => {
    const { s, id } = started(setup(campus, [cartAt("CART-01", "a")]), "c", "e");
    const before = snapshot(s);
    expect(board(s, id)).toMatchObject({ ok: false });
    expect(dropOff(s, id)).toMatchObject({ ok: false });
    expect(snapshot(s)).toBe(before);
  });
});
