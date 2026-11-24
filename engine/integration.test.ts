/**
 * Phase 1 Part 4: core engine integration tests. Real modules only (campus validation, graph,
 * cart rules, fleet store, ride lifecycle, simulation); nothing is mocked.
 */
import { describe, expect, it } from "vitest";
import { CampusConfig } from "../shared/schemas";
import { routeEtaSeconds, shortestRoute } from "./campusGraph";
import { checkCampus } from "./campusValidation";
import { checkCartEligibility } from "./cartRules";
import { createFleet, getCart } from "./fleet";
import * as R from "./rides";
import { advance } from "./simulation";
import { cartAt, lineCampus, loadValidCampus, ok, setup, snapshot } from "./testRideFixtures";

const cartOf = (s: R.RideState, id = "CART-01") => {
  const c = getCart(s.fleet, id);
  if (!c.ok) throw new Error(c.error.message);
  return c.cart;
};

describe("G3: trip stops must match the request", () => {
  it("the invariants flag a trip whose pickup or destination differs from its request", () => {
    let s = setup(lineCampus(), [cartAt("CART-01", "a")]);
    const r = ok(R.createRequest(s, { studentId: "s", pickupId: "b", destinationId: "d" }));
    s = ok(R.assignCart(r.state, r.request.id, "CART-01")).state;
    const t = [...s.trips.values()][0]!;
    const wrongPickup = R.withChanges(s, { trips: [R.makeTrip({ ...t, stops: [{ ...t.stops[0]!, locationId: "e" }, t.stops[1]!] })] });
    expect(R.checkRideInvariants(wrongPickup)).toContain(`${t.id} pickup "e" does not match ${r.request.id} pickup "b"`);
    const wrongDest = R.withChanges(s, { trips: [R.makeTrip({ ...t, stops: [t.stops[0]!, { ...t.stops[1]!, locationId: "a" }] })] });
    expect(R.checkRideInvariants(wrongDest)).toContain(`${t.id} destination "a" does not match ${r.request.id} destination "d"`);
    const noBoard = R.withChanges(s, { trips: [R.makeTrip({ ...t, stops: [{ ...t.stops[0]!, board: [] }, t.stops[1]!] })] });
    expect(R.checkRideInvariants(noBoard).join("; ")).toContain("does not board");
    expect(R.checkRideInvariants(s)).toEqual([]);
  });
});

const WADI = "campus/fictional-campus.json";
const VALLEY = "campus/demo-valley.json";

describe("G1: campus and fleet must match, not just their ids", () => {
  const A = lineCampus();
  const sameIdWithoutA = CampusConfig.parse({ ...A, locations: A.locations.filter((l) => l.id !== "a"), paths: A.paths.filter((p) => p.id !== "ab") });

  it("refuses a fleet whose cart location is missing from the supplied campus", () => {
    const f = createFleet(A, [cartAt("CART-01", "a")]);
    if (!f.ok) throw new Error("setup");
    expect(R.createRideState(sameIdWithoutA, f.fleet)).toEqual({
      ok: false, error: { code: "INCONSISTENT_STATE", message: 'CART-01 is at "a", which is not a location on the supplied campus "line"' },
    });
  });

  it("refuses a fleet whose cart path is missing from the supplied campus", () => {
    // Only reachable with a fleet built elsewhere: a cart on path "ab" while the campus has no "ab".
    const f = createFleet(A, [cartAt("CART-01", "a", { position: { kind: "on_path", pathId: "ab", progress: 0.4 } })]);
    if (!f.ok) throw new Error("setup");
    expect(R.createRideState(sameIdWithoutA, f.fleet)).toMatchObject({
      ok: false, error: { code: "INCONSISTENT_STATE", message: 'CART-01 is on path "ab", which is not a path on the supplied campus "line"' },
    });
  });

  it("still refuses a different campus id, and accepts a matching campus", () => {
    const valley = loadValidCampus(VALLEY);
    const f = createFleet(valley, [cartAt("CART-01", "depot")]);
    if (!f.ok) throw new Error("setup");
    expect(R.createRideState(A, f.fleet)).toMatchObject({ ok: false, error: { code: "INCONSISTENT_STATE" } });
    expect(R.createRideState(valley, f.fleet).ok).toBe(true);
  });
});

describe("G2: updateCartInRide keeps ride rules", () => {
  function onPlannedTrip() {
    let s = setup(lineCampus(), [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const r = ok(R.createRequest(s, { studentId: "s", pickupId: "b", destinationId: "d" }));
    s = ok(R.assignCart(r.state, r.request.id, "CART-01")).state;
    return { s, id: r.request.id };
  }

  it("updates a free cart through the fleet store (idle -> charging -> idle)", () => {
    const { s } = onPlannedTrip();
    const charging = ok(R.updateCartInRide(s, "CART-02", { status: "charging", batteryPercent: 40 }));
    expect(charging.cart).toMatchObject({ status: "charging", batteryPercent: 40 });
    expect(cartOf(s, "CART-02").status).toBe("idle"); // original untouched
    expect(ok(R.updateCartInRide(charging.state, "CART-02", { status: "idle" })).cart.status).toBe("idle");
  });

  it("allows battery, range and driver changes on a cart that is on a trip", () => {
    const { s } = onPlannedTrip();
    const r = ok(R.updateCartInRide(s, "CART-01", { batteryPercent: 50, rangeKm: 12, driverId: "drv-yazan" }));
    expect(r.cart).toMatchObject({ status: "assigned", batteryPercent: 50, rangeKm: 12, driverId: "drv-yazan" });
  });

  const refused: Array<[string, string, unknown, string]> = [
    ["teleporting an assigned cart away from its trip", "CART-01", { position: { kind: "at", locationId: "e" } }, "CART_ON_TRIP"],
    ["freeing an assigned cart by hand", "CART-01", { status: "idle" }, "CART_ON_TRIP"],
    ["sending an assigned cart to charge", "CART-01", { status: "charging" }, "CART_ON_TRIP"],
    ["adding passengers by hand", "CART-01", { passengerCount: 1, status: "occupied" }, "CART_ON_TRIP"],
    ["marking a free cart assigned without a trip", "CART-02", { status: "assigned" }, "INCONSISTENT_STATE"],
    ["parking a free cart mid-path", "CART-02", { position: { kind: "on_path", pathId: "de", progress: 0.5 } }, "INCONSISTENT_STATE"],
    ["a location not on the campus", "CART-02", { position: { kind: "at", locationId: "mars" } }, "INVALID_CART_UPDATE"],
    ["an invalid battery", "CART-02", { batteryPercent: 120 }, "INVALID_CART_UPDATE"],
    ["changing a specification field", "CART-02", { seats: 6 }, "INVALID_CART_UPDATE"],
    ["an unknown cart", "CART-99", { batteryPercent: 50 }, "UNKNOWN_CART"],
  ];
  it.each(refused)("refuses %s and leaves the whole state unchanged", (_n, cartId, patch, code) => {
    const { s } = onPlannedTrip();
    const before = snapshot(s);
    const r = R.updateCartInRide(s, cartId, patch);
    expect(r).toMatchObject({ ok: false, error: { code } });
    expect(snapshot(s)).toBe(before);
  });

  it("refuses moving a cart that is driving or cleaning up", () => {
    let { s, id } = onPlannedTrip();
    s = ok(R.startTrip(s, id)).state;
    s = ok(advance(s, 5)).state;
    expect(R.updateCartInRide(s, "CART-01", { position: { kind: "on_path", pathId: "ab", progress: 0.9 } })).toMatchObject({ ok: false, error: { code: "CART_ON_TRIP" } });
    s = ok(R.cancel(s, id)).state;
    expect(R.updateCartInRide(s, "CART-01", { status: "idle" })).toMatchObject({ ok: false, error: { code: "CART_ON_TRIP" } });
  });
});

/** Advance in fixed ticks until the cart stands at `locationId`, checking invariants after every tick. */
function driveTo(s: R.RideState, cartId: string, locationId: string, tick = 1, maxSeconds = 3600): R.RideState {
  for (let t = 0; t < maxSeconds; t += tick) {
    const pos = cartOf(s, cartId).position;
    if (pos.kind === "at" && pos.locationId === locationId) return s;
    s = ok(advance(s, tick)).state;
    expect(R.checkRideInvariants(s)).toEqual([]);
  }
  throw new Error(`${cartId} did not reach ${locationId} within ${maxSeconds} s`);
}

function fullRide(file: string, cartStart: string, pickupId: string, destinationId: string) {
  const campus = loadValidCampus(file);
  expect(checkCampus(campus).errors).toEqual([]);
  let s = setup(campus, [cartAt("CART-01", cartStart, { maxSpeedKmh: 15 }), cartAt("CART-02", cartStart, { status: "charging" }), cartAt("CART-03", cartStart, { batteryPercent: 14.9 })]);
  const idle2 = cartOf(s, "CART-02");
  const idle3 = cartOf(s, "CART-03");
  const etaOf = (a: string, b: string) => { const r = shortestRoute(s.graph, a, b); if (!r.ok) throw new Error(r.error.message); return routeEtaSeconds(s.graph, r.route, 15); };

  const req = ok(R.createRequest(s, { studentId: "stu-lina", pickupId, destinationId }));
  s = req.state;
  const id = req.request.id;
  s = ok(R.assignCart(s, id, "CART-01")).state;
  expect(cartOf(s)).toMatchObject({ status: "assigned", passengerCount: 0 });
  expect(R.rideEta(s, id)).toEqual({ ok: true, pickupSeconds: etaOf(cartStart, pickupId), destinationSeconds: etaOf(cartStart, pickupId) + etaOf(pickupId, destinationId) });

  s = ok(R.startTrip(s, id)).state;
  expect(s.requests.get(id)!.status).toBe("arriving");
  s = driveTo(s, "CART-01", pickupId);
  const atPickupClock = s.clockSeconds;
  expect(Math.abs(atPickupClock - etaOf(cartStart, pickupId))).toBeLessThanOrEqual(1);
  expect(cartOf(s)).toMatchObject({ status: "assigned", passengerCount: 0 });

  s = ok(R.board(s, id)).state;
  expect(cartOf(s)).toMatchObject({ status: "occupied", passengerCount: 1 });
  expect(s.requests.get(id)!.status).toBe("on_board");
  s = driveTo(s, "CART-01", destinationId);
  expect(Math.abs(s.clockSeconds - atPickupClock - etaOf(pickupId, destinationId))).toBeLessThanOrEqual(1);

  s = ok(R.dropOff(s, id)).state;
  const trip = R.tripForRequest(s, id)!;
  expect(s.requests.get(id)).toMatchObject({ status: "completed", createdAt: 0, updatedAt: Math.round(s.clockSeconds * 1000), fareJod: 0.25 });
  expect(trip).toMatchObject({ status: "completed", stopIndex: 2, leg: null, cartId: "CART-01", passengers: [{ requestId: id, boarded: true }] });
  expect(trip.stops.map((x) => x.locationId)).toEqual([pickupId, destinationId]);
  expect(cartOf(s)).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: destinationId } });
  expect(checkCartEligibility(cartOf(s)).eligible).toBe(true);
  expect(cartOf(s, "CART-02")).toEqual(idle2);
  expect(cartOf(s, "CART-03")).toEqual(idle3);
  expect(R.checkRideInvariants(s)).toEqual([]);
  return s;
}

describe("full ride on the real campuses", () => {
  it("Wadi Cedar: depot -> pickup library -> destination north gate", () => {
    fullRide(WADI, "depot", "library", "north-gate");
  });

  it("Demo Valley: the same cart data works after switching campus (both have a depot)", () => {
    fullRide(VALLEY, "depot", "hall-b", "lot-1");
  });
});

describe("ETA against actual simulated movement", () => {
  it.each([WADI, VALLEY])("%s: every location pair, pickup and destination", (file) => {
    const campus = loadValidCampus(file);
    const ids = campus.locations.map((l) => l.id);
    const at = (s: R.RideState, loc: string) => { const p = cartOf(s).position; return p.kind === "at" && p.locationId === loc; };
    for (const from of ids) for (const pickup of ids) {
      if (from === pickup) continue;
      const dest = ids.find((x) => x !== pickup)!;
      let s = setup(campus, [cartAt("CART-01", from, { maxSpeedKmh: 15 })]);
      const r = ok(R.createRequest(s, { studentId: "s", pickupId: pickup, destinationId: dest }));
      s = ok(R.startTrip(ok(R.assignCart(r.state, r.request.id, "CART-01")).state, r.request.id)).state;
      const eta = R.rideEta(s, r.request.id);
      if (!eta.ok) throw new Error(eta.error.message);
      const tag = `${from} -> ${pickup}`;
      if (eta.pickupSeconds! > 1) expect(at(ok(advance(s, eta.pickupSeconds! - 1)).state, pickup), tag).toBe(false);
      const arrived = ok(advance(s, eta.pickupSeconds! + 1)).state;
      expect(at(arrived, pickup), tag).toBe(true);
      const boarded = ok(R.board(arrived, r.request.id)).state;
      const after = R.rideEta(boarded, r.request.id);
      if (!after.ok) throw new Error(after.error.message);
      expect(Math.abs(after.destinationSeconds - (eta.destinationSeconds - eta.pickupSeconds!)), tag).toBeLessThanOrEqual(1);
    }
  });
});

describe("one-way campus variant (passes Part 1 validation)", () => {
  const valley = loadValidCampus(VALLEY);
  const oneWay = CampusConfig.parse({ ...valley, paths: valley.paths.map((p) => (p.id === "lot-1--depot" ? { ...p, oneWay: true } : p)) });

  it("is accepted by campus validation: still strongly connected", () => {
    expect(checkCampus(oneWay)).toMatchObject({ errors: [], connectivity: { stronglyConnected: true, oneWayPathIds: ["lot-1--depot"] } });
  });

  it("a full ride never drives the one-way path backwards", () => {
    let s = setup(oneWay, [cartAt("CART-01", "depot")]);
    const r = ok(R.createRequest(s, { studentId: "s", pickupId: "lot-1", destinationId: "depot" }));
    s = ok(R.assignCart(r.state, r.request.id, "CART-01")).state;
    const started = ok(R.startTrip(s, r.request.id));
    expect(started.trip.leg).toEqual({ locationIds: ["depot", "quad-stop", "lot-1"], pathIds: ["quad-stop--depot", "quad-stop--lot-1"] });
    s = driveTo(started.state, "CART-01", "lot-1");
    const boarded = ok(R.board(s, r.request.id));
    expect(boarded.trip.leg).toEqual({ locationIds: ["lot-1", "depot"], pathIds: ["lot-1--depot"] }); // with the arrow
    s = driveTo(boarded.state, "CART-01", "depot");
    s = ok(R.dropOff(s, r.request.id)).state;
    expect(cartOf(s)).toMatchObject({ status: "idle", position: { kind: "at", locationId: "depot" } });
  });

  it("cleanup on a reversed two-way path finishes in the direction of travel", () => {
    let s = setup(oneWay, [cartAt("CART-01", "depot")]);
    const r = ok(R.createRequest(s, { studentId: "s", pickupId: "main-gate", destinationId: "hall-a" }));
    s = ok(R.startTrip(ok(R.assignCart(r.state, r.request.id, "CART-01")).state, r.request.id)).state;
    s = ok(advance(s, 30)).state; // on "quad-stop--depot", driving depot -> quad-stop (reverse)
    const pos = cartOf(s).position;
    expect(pos.kind === "on_path" && pos.pathId).toBe("quad-stop--depot");
    const cancelled = ok(R.cancel(s, r.request.id));
    expect(cancelled.trip!.leg).toEqual({ locationIds: ["depot", "quad-stop"], pathIds: ["quad-stop--depot"] });
    expect(cartOf(cancelled.state)).toEqual(cartOf(s));
    const done = ok(advance(cancelled.state, 600)).state;
    expect(cartOf(done)).toMatchObject({ status: "idle", position: { kind: "at", locationId: "quad-stop" } });
  });
});

describe("several carts and eligibility boundaries on Wadi Cedar", () => {
  it("runs two rides at once, refuses ineligible carts, and keeps carts independent", () => {
    const campus = loadValidCampus(WADI);
    let s = setup(campus, [
      cartAt("CART-01", "depot"), cartAt("CART-02", "north-gate"),
      cartAt("CART-03", "library", { status: "charging" }), cartAt("CART-04", "library", { status: "offline" }),
      cartAt("CART-05", "admin", { status: "maintenance" }), cartAt("CART-06", "admin", { batteryPercent: 14.9 }),
      cartAt("CART-07", "admin", { batteryPercent: 15 }),
    ]);
    const a = ok(R.createRequest(s, { studentId: "stu-lina", pickupId: "library", destinationId: "south-gate" }));
    const b = ok(R.createRequest(a.state, { studentId: "stu-omar", pickupId: "science", destinationId: "business" }));
    const c = ok(R.createRequest(b.state, { studentId: "stu-sara", pickupId: "engineering", destinationId: "sports" }));
    s = c.state;
    for (const [cart, msg] of [["CART-03", "charging"], ["CART-04", "offline"], ["CART-05", "maintenance"], ["CART-06", "below the 15% reserve"]] as const) {
      const r = R.assignCart(s, c.request.id, cart);
      expect(r, cart).toMatchObject({ ok: false, error: { code: "CART_INELIGIBLE" } });
      if (!r.ok) expect(r.error.message).toContain(msg);
    }
    s = ok(R.assignCart(s, a.request.id, "CART-01")).state;
    s = ok(R.assignCart(s, b.request.id, "CART-02")).state;
    s = ok(R.assignCart(s, c.request.id, "CART-07")).state; // exactly 15% is enough
    expect(R.assignCart(s, c.request.id, "CART-01")).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    const d = ok(R.createRequest(s, { studentId: "s", pickupId: "admin", destinationId: "depot" }));
    expect(R.assignCart(d.state, d.request.id, "CART-01")).toMatchObject({ ok: false, error: { code: "CART_ALREADY_ASSIGNED" } });

    s = ok(R.startTrip(s, a.request.id)).state;
    s = ok(R.startTrip(s, b.request.id)).state;
    const untouched = ["CART-03", "CART-04", "CART-05", "CART-06"].map((id) => cartOf(s, id));
    s = driveTo(s, "CART-01", "library");
    s = ok(R.board(s, a.request.id)).state;
    s = driveTo(s, "CART-02", "science");
    s = ok(R.board(s, b.request.id)).state;
    s = driveTo(s, "CART-01", "south-gate");
    s = ok(R.dropOff(s, a.request.id)).state;
    s = driveTo(s, "CART-02", "business");
    s = ok(R.dropOff(s, b.request.id)).state;
    expect(["CART-03", "CART-04", "CART-05", "CART-06"].map((id) => cartOf(s, id))).toEqual(untouched);
    expect(cartOf(s, "CART-07")).toMatchObject({ status: "assigned", position: { kind: "at", locationId: "admin" } }); // planned, never started
    expect([...s.requests.values()].map((r) => r.status)).toEqual(["completed", "completed", "assigned"]);
  });
});

describe("cancellation, cleanup and reassignment on Wadi Cedar", () => {
  it("a cart cancelled mid-path finishes its path, then completes a new ride", () => {
    const campus = loadValidCampus(WADI);
    let s = setup(campus, [cartAt("CART-01", "depot", { maxSpeedKmh: 15 })]);
    const first = ok(R.createRequest(s, { studentId: "stu-lina", pickupId: "north-gate", destinationId: "admin" }));
    s = ok(R.startTrip(ok(R.assignCart(first.state, first.request.id, "CART-01")).state, first.request.id)).state;
    const leg = R.tripForRequest(s, first.request.id)!.leg!;
    s = ok(advance(s, 30)).state; // part-way along the first path
    const pos = cartOf(s).position;
    expect(pos.kind).toBe("on_path");
    s = ok(R.cancel(s, first.request.id)).state;
    expect(R.tripForRequest(s, first.request.id)).toMatchObject({ status: "cancelling", leg: { locationIds: leg.locationIds.slice(0, 2), pathIds: leg.pathIds.slice(0, 1) } });
    const second = ok(R.createRequest(s, { studentId: "stu-omar", pickupId: "library", destinationId: "south-gate" }));
    s = second.state;
    expect(R.assignCart(s, second.request.id, "CART-01")).toMatchObject({ ok: false, error: { code: "CART_ALREADY_ASSIGNED" } });
    s = driveTo(s, "CART-01", leg.locationIds[1]!);
    expect(R.tripForRequest(s, first.request.id)!.status).toBe("cancelled");
    s = ok(R.assignCart(s, second.request.id, "CART-01")).state;
    s = ok(R.startTrip(s, second.request.id)).state;
    s = driveTo(s, "CART-01", "library");
    s = ok(R.board(s, second.request.id)).state;
    expect(R.cancel(s, second.request.id)).toMatchObject({ ok: false, error: { code: "CANNOT_CANCEL_ON_BOARD" } });
    s = driveTo(s, "CART-01", "south-gate");
    s = ok(R.dropOff(s, second.request.id)).state;
    expect([...s.requests.values()].map((r) => r.status)).toEqual(["cancelled", "completed"]);
    expect([...s.trips.values()].map((t) => t.status)).toEqual(["cancelled", "completed"]);
    expect(cartOf(s)).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "south-gate" } });
  });
});

describe("deterministic replay and tick size on Wadi Cedar", () => {
  type Step = { advance: number } | { label: string; run: (s: R.RideState) => unknown };
  const reqId = (n: number) => `REQ-000${n}`;
  const SCRIPT: Step[] = [
    { label: "create R1", run: (s) => R.createRequest(s, { studentId: "stu-lina", pickupId: "library", destinationId: "south-gate" }) },
    { label: "create R2", run: (s) => R.createRequest(s, { studentId: "stu-omar", pickupId: "science", destinationId: "business" }) },
    { label: "create same-place (fails)", run: (s) => R.createRequest(s, { studentId: "x", pickupId: "admin", destinationId: "admin" }) },
    { label: "assign R1 to charging CART-03 (fails)", run: (s) => R.assignCart(s, reqId(1), "CART-03") },
    { label: "assign R1 CART-01", run: (s) => R.assignCart(s, reqId(1), "CART-01") },
    { label: "assign R2 CART-02", run: (s) => R.assignCart(s, reqId(2), "CART-02") },
    { label: "board R1 too early (fails)", run: (s) => R.board(s, reqId(1)) },
    { label: "start R1", run: (s) => R.startTrip(s, reqId(1)) },
    { label: "start R2", run: (s) => R.startTrip(s, reqId(2)) },
    { label: "eta R1", run: (s) => R.rideEta(s, reqId(1)) },
    { label: "eta R2", run: (s) => R.rideEta(s, reqId(2)) },
    { advance: 40 },
    { label: "eta R1 after 40 s", run: (s) => R.rideEta(s, reqId(1)) },
    { label: "cancel R2 mid-path", run: (s) => R.cancel(s, reqId(2)) },
    { label: "cancel R2 again (fails)", run: (s) => R.cancel(s, reqId(2)) },
    { label: "advance 0 s (throws)", run: (s) => advance(s, 0) },
    { label: "charge CART-02 during cleanup (fails)", run: (s) => R.updateCartInRide(s, "CART-02", { status: "charging" }) },
    { advance: 200 },
    { label: "board R1", run: (s) => R.board(s, reqId(1)) },
    { label: "assign finished R2 (fails)", run: (s) => R.assignCart(s, reqId(2), "CART-02") },
    { label: "create R3", run: (s) => R.createRequest(s, { studentId: "stu-sara", pickupId: "admin", destinationId: "depot" }) },
    { label: "assign R3 CART-02", run: (s) => R.assignCart(s, reqId(3), "CART-02") },
    { label: "start R3", run: (s) => R.startTrip(s, reqId(3)) },
    { label: "cancel R1 on board (fails)", run: (s) => R.cancel(s, reqId(1)) },
    { advance: 300 },
    { label: "drop off R1", run: (s) => R.dropOff(s, reqId(1)) },
    { label: "board R3", run: (s) => R.board(s, reqId(3)) },
    { label: "eta R3", run: (s) => R.rideEta(s, reqId(3)) },
    { label: "unknown request (fails)", run: (s) => R.startTrip(s, "REQ-9999") },
    { advance: 300 },
    { label: "drop off R3", run: (s) => R.dropOff(s, reqId(3)) },
  ];

  /** Run the script, with every advance split into ticks of `tick` seconds (Infinity = one call). */
  function runScript(tick: number) {
    const campus = loadValidCampus(WADI);
    let s = setup(campus, [
      cartAt("CART-01", "depot", { maxSpeedKmh: 15 }), cartAt("CART-02", "north-gate", { maxSpeedKmh: 15 }),
      cartAt("CART-03", "library", { status: "charging" }),
    ]);
    const results: string[] = [];
    for (const step of SCRIPT) {
      if ("advance" in step) {
        for (let t = 0; t < step.advance - 1e-9; t += tick) s = ok(advance(s, Math.min(tick, step.advance - t))).state;
        continue;
      }
      const before = snapshot(s);
      let r: any;
      try { r = step.run(s); } catch (e) { r = { ok: false, error: { code: (e as Error).name } }; }
      // Every call leaves its input untouched; a failing call changes nothing at all (clock and counters included).
      expect(snapshot(s), step.label).toBe(before);
      if (r.ok && r.state) s = r.state;
      const { state: _omit, ...rest } = r;
      // Phase 4: a trip's drivenSeconds sums many small steps, so it is rounded to 1e-9 like progress.
      results.push(`${step.label}: ${JSON.stringify(rest, (k, v) => (k === "drivenSeconds" ? Math.round(v * 1e9) / 1e9 : v))}`);
      expect(R.checkRideInvariants(s), step.label).toEqual([]);
    }
    return { s, results };
  }

  it("the same script from the same start gives identical states and results", () => {
    const a = runScript(1);
    const b = runScript(1);
    expect(snapshot(b.s)).toBe(snapshot(a.s));
    expect(b.results).toEqual(a.results);
  });

  it("the script really exercises successes, failures, cleanup and completion", () => {
    const { s, results } = runScript(1);
    const codes = results.filter((r) => r.includes('"ok":false')).map((r) => r.match(/"code":"(\w+)"/)![1]);
    expect(codes).toEqual(["SAME_LOCATION", "CART_INELIGIBLE", "INVALID_TRANSITION", "ALREADY_CANCELLING", "RangeError", "CART_ON_TRIP", "RIDE_FINISHED", "CANNOT_CANCEL_ON_BOARD", "UNKNOWN_REQUEST"]);
    expect([...s.requests.values()].map((r) => [r.id, r.status])).toEqual([["REQ-0001", "completed"], ["REQ-0002", "cancelled"], ["REQ-0003", "completed"]]);
    expect([...s.trips.values()].map((t) => [t.id, t.status])).toEqual([["TRIP-0001", "completed"], ["TRIP-0002", "cancelled"], ["TRIP-0003", "completed"]]);
    expect(s.nextRequestNo).toBe(4);
    expect(s.nextTripNo).toBe(4);
    expect(s.clockSeconds).toBe(840);
    expect(cartOf(s, "CART-01")).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "south-gate" } });
    expect(cartOf(s, "CART-02")).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "depot" } });
    expect(cartOf(s, "CART-03")).toMatchObject({ status: "charging", position: { kind: "at", locationId: "library" } });
  });

  it("the same total time in different tick sizes gives the same states and results", () => {
    const base = runScript(Infinity);
    for (const tick of [0.5, 1, 7]) {
      const r = runScript(tick);
      expect(snapshot(r.s), `tick ${tick}`).toBe(snapshot(base.s));
      expect(r.results, `tick ${tick}`).toEqual(base.results);
    }
  });
});
