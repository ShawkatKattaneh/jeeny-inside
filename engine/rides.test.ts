import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CampusConfig } from "../shared/schemas";
import { buildGraph, routeEtaSeconds, shortestRoute } from "./campusGraph";
import { checkCartEligibility } from "./cartRules";
import { createFleet, getCart } from "./fleet";
import {
  assignCart, board, cancel, checkRideInvariants, createRequest, createRideState, dropOff, getRequest,
  openTripForCart, rideEta, startTrip, tripForRequest, type RideState,
} from "./rides";
import { advance } from "./simulation";
import { cartAt, lineCampus, ok, setup } from "./testRideFixtures";

const campus = lineCampus();
const cart = (s: RideState, id = "CART-01") => {
  const c = getCart(s.fleet, id);
  if (!c.ok) throw new Error(c.error.message);
  return c.cart;
};
const status = (s: RideState, reqId: string) => s.requests.get(reqId)!.status;

/** A requested ride b -> d with CART-01 waiting at a. */
function requested(carts = [cartAt("CART-01", "a")]) {
  const s0 = setup(campus, carts);
  const r = ok(createRequest(s0, { studentId: "stu-lina", pickupId: "b", destinationId: "d" }));
  return { s: r.state, id: r.request.id };
}

describe("createRideState", () => {
  it("rejects a fleet built for another campus", () => {
    const valley = CampusConfig.parse(JSON.parse(readFileSync("campus/demo-valley.json", "utf8")));
    const f = createFleet(valley, [cartAt("CART-01", "depot")]);
    if (!f.ok) throw new Error("setup");
    expect(createRideState(campus, f.fleet)).toMatchObject({ ok: false, error: { code: "INCONSISTENT_STATE" } });
  });

  it("rejects a fleet whose carts claim a trip that does not exist", () => {
    const f = createFleet(campus, [cartAt("CART-01", "a", { status: "assigned" })]);
    if (!f.ok) throw new Error("setup");
    const r = createRideState(campus, f.fleet);
    expect(r).toMatchObject({ ok: false, error: { code: "INCONSISTENT_STATE" } });
    if (!r.ok) expect(r.error.message).toContain("CART-01 is assigned without a trip");
  });
});

describe("createRequest", () => {
  const s0 = setup(campus, [cartAt("CART-01", "a")]);

  it("creates a solo request with a counter id, simulated fare and sim-clock timestamps", () => {
    const r = ok(createRequest(s0, { studentId: "stu-lina", pickupId: "b", destinationId: "d" }));
    expect(r.request).toEqual({
      id: "REQ-0001", studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "solo", priority: false,
      status: "requested", createdAt: 0, updatedAt: 0, fareJod: 0.25, freeLoyaltyRide: false,
    });
    const r2 = ok(createRequest(r.state, { studentId: "stu-omar", pickupId: "a", destinationId: "e" }));
    expect(r2.request.id).toBe("REQ-0002");
    expect(s0.requests.size).toBe(0);
  });

  it.each([
    [{ studentId: "", pickupId: "a", destinationId: "b" }, "INVALID_REQUEST"],
    [{ studentId: "s", pickupId: "mars", destinationId: "b" }, "UNKNOWN_LOCATION"],
    [{ studentId: "s", pickupId: "a", destinationId: "mars" }, "UNKNOWN_LOCATION"],
    [{ studentId: "s", pickupId: "a", destinationId: "x" }, "NOT_A_STOP"],
    [{ studentId: "s", pickupId: "c", destinationId: "c" }, "SAME_LOCATION"],
    // Phase 4: "solo" and "shared" are valid modes (D12); any other mode is still refused.
    [{ studentId: "s", pickupId: "a", destinationId: "b", mode: "pooled" }, "INVALID_REQUEST"],
    [{ studentId: "s", pickupId: "a", destinationId: "b", priority: true }, "INVALID_REQUEST"],
  ])("rejects %o with %s and leaves the state unchanged", (input, code) => {
    const r = createRequest(s0, input);
    expect(r).toMatchObject({ ok: false, error: { code } });
    expect(s0.requests.size).toBe(0);
    expect(s0.nextRequestNo).toBe(1);
  });

  it("rejects a request with no route", () => {
    // f is a stop with no paths at all (a deliberately broken campus; real ones are checked at load).
    const c = lineCampus({ locations: [...campus.locations, { id: "f", name: "f", type: "pickup", position: { x: 590, y: 150 }, canStop: true }] });
    const s = setup(c, []);
    expect(createRequest(s, { studentId: "s", pickupId: "a", destinationId: "f" })).toMatchObject({ ok: false, error: { code: "NO_ROUTE" } });
  });

  it("rejects missing input", () => {
    expect(createRequest(s0, null as never)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });
});

describe("assignCart (manual, by id)", () => {
  it("assigns an idle eligible cart: trip planned, cart assigned, request assigned", () => {
    const { s, id } = requested();
    const r = ok(assignCart(s, id, "CART-01"));
    expect(r.trip).toEqual({
      id: "TRIP-0001", cartId: "CART-01",
      stops: [{ locationId: "b", board: [id], alight: [] }, { locationId: "d", board: [], alight: [id] }],
      // Phase 4: each rider carries its own lifecycle flags and original solo baseline (D2); the trip
      // starts with zero actual driving time. a -> b is 100 m and b -> d 200 m at 10 m/s.
      passengers: [{
        requestId: id, boarded: false, droppedOff: false, cancelled: false,
        baseline: { soloPickupSeconds: 10, soloRideSeconds: 20, pickupMark: 10, dropOffMark: 30, cartId: "CART-01", recordedAtClock: 0 },
      }],
      status: "planned", stopIndex: 0, leg: null, drivenSeconds: 0,
    });
    expect(cart(r.state)).toMatchObject({ status: "assigned", passengerCount: 0, position: { kind: "at", locationId: "a" } });
    expect(status(r.state, id)).toBe("assigned");
    // The original state is untouched.
    expect(cart(s).status).toBe("idle");
    expect(s.trips.size).toBe(0);
  });

  it("an assigned cart fails the basic eligibility check", () => {
    const { s, id } = requested();
    const r = ok(assignCart(s, id, "CART-01"));
    expect(checkCartEligibility(cart(r.state))).toMatchObject({ eligible: false, reasons: ["NOT_IN_SERVICE"], messages: ["CART-01 is assigned and not available"] });
  });

  const cases: Array<[string, Parameters<typeof cartAt>[2], string, RegExp]> = [
    ["charging", { status: "charging" }, "CART_INELIGIBLE", /is charging and not available/],
    ["offline", { status: "offline" }, "CART_INELIGIBLE", /is offline/],
    ["maintenance", { status: "maintenance" }, "CART_INELIGIBLE", /is maintenance/],
    ["below the battery reserve (14.9%)", { batteryPercent: 14.9 }, "CART_INELIGIBLE", /below the 15% reserve/],
  ];
  it.each(cases)("refuses a cart that is %s", (_n, over, code, msg) => {
    const { s, id } = requested([cartAt("CART-01", "a", over)]);
    const r = assignCart(s, id, "CART-01");
    expect(r).toMatchObject({ ok: false, error: { code } });
    if (!r.ok) expect(r.error.message).toMatch(msg);
    expect(s.trips.size).toBe(0);
  });

  it("accepts a cart at exactly the 15% reserve", () => {
    const { s, id } = requested([cartAt("CART-01", "a", { batteryPercent: 15 })]);
    expect(assignCart(s, id, "CART-01").ok).toBe(true);
  });

  it("refuses an unknown cart id", () => {
    const { s, id } = requested();
    expect(assignCart(s, id, "CART-99")).toEqual({ ok: false, error: { code: "UNKNOWN_CART", message: 'No cart with id "CART-99" in this fleet' } });
  });

  it("refuses an unknown request, and a request that is not in the requested state", () => {
    const { s, id } = requested();
    expect(assignCart(s, "REQ-9999", "CART-01")).toMatchObject({ ok: false, error: { code: "UNKNOWN_REQUEST" } });
    const a = ok(assignCart(s, id, "CART-01"));
    expect(assignCart(a.state, id, "CART-01")).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
  });

  it("refuses a cart already assigned to another ride (exclusivity)", () => {
    const { s, id } = requested();
    const a = ok(assignCart(s, id, "CART-01"));
    const second = ok(createRequest(a.state, { studentId: "stu-omar", pickupId: "c", destinationId: "e" }));
    const r = assignCart(second.state, second.request.id, "CART-01");
    expect(r).toMatchObject({ ok: false, error: { code: "CART_ALREADY_ASSIGNED", message: "CART-01 is already on trip TRIP-0001" } });
  });

  it("refuses an occupied cart (solo rides only)", () => {
    let { s, id } = requested([cartAt("CART-01", "b")]);
    s = ok(assignCart(s, id, "CART-01")).state;
    s = ok(startTrip(s, id)).state;
    s = ok(board(s, id)).state;
    const other = ok(createRequest(s, { studentId: "stu-omar", pickupId: "c", destinationId: "e" }));
    expect(assignCart(other.state, other.request.id, "CART-01")).toMatchObject({ ok: false, error: { code: "CART_ALREADY_ASSIGNED" } });
  });

  it("a cart must be at a location to be assigned (D10)", () => {
    // The only way a cart is mid-path is on a trip: start a ride, drive halfway, cancel.
    let { s, id } = requested();
    s = ok(assignCart(s, id, "CART-01")).state;
    s = ok(startTrip(s, id)).state;
    s = ok(advance(s, 5)).state;
    s = ok(cancel(s, id)).state;
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "ab", progress: 0.5 });
    const other = ok(createRequest(s, { studentId: "stu-omar", pickupId: "c", destinationId: "e" }));
    expect(assignCart(other.state, other.request.id, "CART-01")).toMatchObject({ ok: false, error: { code: "CART_ALREADY_ASSIGNED" } });
    // An idle cart parked mid-path cannot exist in a ride state at all.
    const f = createFleet(campus, [cartAt("CART-01", "a", { position: { kind: "on_path", pathId: "ab", progress: 0.5 } })]);
    if (!f.ok) throw new Error("setup");
    const r = createRideState(campus, f.fleet);
    expect(r).toMatchObject({ ok: false, error: { code: "INCONSISTENT_STATE" } });
    if (!r.ok) expect(r.error.message).toContain('CART-01 is on path "ab" outside any trip leg');
  });

  it("refuses when the cart cannot reach the pickup", () => {
    const c = lineCampus({
      locations: [...campus.locations, { id: "f", name: "f", type: "pickup", position: { x: 590, y: 150 }, canStop: true }],
    });
    const s0 = setup(c, [cartAt("CART-01", "f")]);
    const r = ok(createRequest(s0, { studentId: "s", pickupId: "a", destinationId: "b" }));
    expect(assignCart(r.state, r.request.id, "CART-01")).toMatchObject({ ok: false, error: { code: "NO_ROUTE" } });
  });
});

describe("lifecycle: start, board, drop-off", () => {
  it("runs a full ride a -> pickup b -> destination d, with cart and ride in step", () => {
    let { s, id } = requested();
    s = ok(assignCart(s, id, "CART-01")).state;

    const started = ok(startTrip(s, id));
    s = started.state;
    expect(started.trip).toMatchObject({ status: "active", stopIndex: 0, leg: { locationIds: ["a", "b"], pathIds: ["ab"] } });
    expect(status(s, id)).toBe("arriving");
    expect(cart(s)).toMatchObject({ status: "assigned", passengerCount: 0 });

    expect(board(s, id)).toMatchObject({ ok: false, error: { code: "NOT_AT_STOP" } });
    s = ok(advance(s, 10)).state; // 100 m at 10 m/s
    expect(cart(s)).toMatchObject({ position: { kind: "at", locationId: "b" }, status: "assigned", passengerCount: 0 });
    expect(status(s, id)).toBe("arriving");

    const boarded = ok(board(s, id));
    s = boarded.state;
    expect(boarded.trip).toMatchObject({ stopIndex: 1, leg: { locationIds: ["b", "c", "d"], pathIds: ["bc", "cd"] }, passengers: [{ boarded: true }] });
    expect(cart(s)).toMatchObject({ status: "occupied", passengerCount: 1 });
    expect(status(s, id)).toBe("on_board");

    expect(dropOff(s, id)).toMatchObject({ ok: false, error: { code: "NOT_AT_STOP" } });
    s = ok(advance(s, 20)).state;
    expect(cart(s)).toMatchObject({ position: { kind: "at", locationId: "d" }, status: "occupied", passengerCount: 1 });

    const done = ok(dropOff(s, id));
    s = done.state;
    expect(done.trip).toMatchObject({ status: "completed", stopIndex: 2, leg: null });
    expect(cart(s)).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "d" } });
    expect(status(s, id)).toBe("completed");
    expect(s.requests.get(id)!.updatedAt).toBe(30_000);
    expect(openTripForCart(s, "CART-01")).toBeUndefined();
    expect(checkCartEligibility(cart(s)).eligible).toBe(true);

    // After completion every lifecycle operation is refused.
    for (const op of [startTrip, board, dropOff, cancel]) expect(op(s, id)).toMatchObject({ ok: false, error: { code: "RIDE_FINISHED" } });
    expect(assignCart(s, id, "CART-01")).toMatchObject({ ok: false, error: { code: "RIDE_FINISHED" } });
  });

  it("a cart already at the pickup can board right after start", () => {
    let { s, id } = requested([cartAt("CART-01", "b")]);
    s = ok(assignCart(s, id, "CART-01")).state;
    const st = ok(startTrip(s, id));
    expect(st.trip.leg).toEqual({ locationIds: ["b"], pathIds: [] });
    expect(ok(board(st.state, id)).state.requests.get(id)!.status).toBe("on_board");
  });

  it("refuses operations out of order", () => {
    const { s, id } = requested();
    expect(startTrip(s, id)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    expect(board(s, id)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    expect(dropOff(s, id)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    const a = ok(assignCart(s, id, "CART-01")).state;
    expect(board(a, id)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    expect(dropOff(a, id)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    const st = ok(startTrip(a, id)).state;
    expect(startTrip(st, id)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    for (const op of [startTrip, board, dropOff, cancel]) expect(op(st, "REQ-9999")).toMatchObject({ ok: false, error: { code: "UNKNOWN_REQUEST" } });
  });

  it("passenger count changes only on board and drop-off", () => {
    let { s, id } = requested();
    const counts: number[] = [cart(s).passengerCount];
    const step = (next: RideState) => { s = next; counts.push(cart(s).passengerCount); };
    step(ok(assignCart(s, id, "CART-01")).state);
    step(ok(startTrip(s, id)).state);
    step(ok(advance(s, 4)).state);
    step(ok(advance(s, 6)).state);
    step(ok(board(s, id)).state);
    step(ok(advance(s, 7)).state);
    step(ok(advance(s, 30)).state);
    step(ok(dropOff(s, id)).state);
    expect(counts).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 0]);
  });
});

describe("cancellation (D3, D4)", () => {
  it("requested: the request is cancelled, no cart involved", () => {
    const { s, id } = requested();
    const r = ok(cancel(s, id));
    expect(r.trip).toBeNull();
    expect(status(r.state, id)).toBe("cancelled");
    expect(cart(r.state).status).toBe("idle");
  });

  it("assigned, not started: trip cancelled, cart idle where it was, and can be assigned again", () => {
    let { s, id } = requested();
    s = ok(assignCart(s, id, "CART-01")).state;
    const r = ok(cancel(s, id));
    expect(r.trip).toMatchObject({ status: "cancelled", leg: null });
    expect(cart(r.state)).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "a" } });
    const again = ok(createRequest(r.state, { studentId: "s", pickupId: "c", destinationId: "e" }));
    expect(assignCart(again.state, again.request.id, "CART-01").ok).toBe(true);
  });

  it("arriving with the cart at a location (between paths, or at the pickup): cancelled at once", () => {
    let { s, id } = requested([cartAt("CART-01", "a")]);
    const c = ok(createRequest(s, { studentId: "s", pickupId: "c", destinationId: "e" }));
    s = ok(assignCart(c.state, c.request.id, "CART-01")).state;
    s = ok(startTrip(s, c.request.id)).state;
    s = ok(advance(s, 10)).state; // exactly at b, an intermediate location
    expect(cart(s).position).toEqual({ kind: "at", locationId: "b" });
    const r = ok(cancel(s, c.request.id));
    expect(r.trip).toMatchObject({ status: "cancelled" });
    expect(cart(r.state)).toMatchObject({ status: "idle", position: { kind: "at", locationId: "b" } });
    expect(id).toBe("REQ-0001");
  });

  it("at the pickup before boarding: cancelled at once", () => {
    let { s, id } = requested([cartAt("CART-01", "b")]);
    s = ok(assignCart(s, id, "CART-01")).state;
    s = ok(startTrip(s, id)).state;
    const r = ok(cancel(s, id));
    expect(cart(r.state)).toMatchObject({ status: "idle", position: { kind: "at", locationId: "b" } });
  });

  it("on board or driving to the destination: refused, nothing changes", () => {
    let { s, id } = requested([cartAt("CART-01", "b")]);
    s = ok(assignCart(s, id, "CART-01")).state;
    s = ok(startTrip(s, id)).state;
    s = ok(board(s, id)).state;
    expect(cancel(s, id)).toMatchObject({ ok: false, error: { code: "CANNOT_CANCEL_ON_BOARD" } });
    s = ok(advance(s, 5)).state;
    const before = s;
    expect(cancel(s, id)).toMatchObject({ ok: false, error: { code: "CANNOT_CANCEL_ON_BOARD" } });
    expect(s).toBe(before);
    expect(cart(s)).toMatchObject({ status: "occupied", passengerCount: 1 });
  });

  it("cancelled twice: refused", () => {
    const { s, id } = requested();
    const r = ok(cancel(s, id));
    expect(cancel(r.state, id)).toMatchObject({ ok: false, error: { code: "RIDE_FINISHED" } });
  });
});

describe("ETA", () => {
  it("before start, matches routeEtaSeconds exactly for both legs", () => {
    const real = CampusConfig.parse(JSON.parse(readFileSync("campus/fictional-campus.json", "utf8")));
    const g = buildGraph(real);
    let s = setup(real, [cartAt("CART-01", "depot", { maxSpeedKmh: 15 })]);
    const r = ok(createRequest(s, { studentId: "s", pickupId: "library", destinationId: "north-gate" }));
    s = ok(assignCart(r.state, r.request.id, "CART-01")).state;
    const leg = (a: string, b: string) => { const x = shortestRoute(g, a, b); if (!x.ok) throw new Error(); return routeEtaSeconds(g, x.route, 15); };
    const eta = rideEta(s, r.request.id);
    expect(eta).toEqual({ ok: true, pickupSeconds: leg("depot", "library"), destinationSeconds: leg("depot", "library") + leg("library", "north-gate") });
    // Right after start, the remaining-leg ETA is the same number.
    s = ok(startTrip(s, r.request.id)).state;
    expect(rideEta(s, r.request.id)).toEqual(eta);
  });

  it("counts down as the cart moves and reaches 0 at the stop", () => {
    let { s, id } = requested();
    s = ok(assignCart(s, id, "CART-01")).state;
    s = ok(startTrip(s, id)).state;
    expect(rideEta(s, id)).toEqual({ ok: true, pickupSeconds: 10, destinationSeconds: 30 });
    s = ok(advance(s, 4)).state;
    expect(rideEta(s, id)).toEqual({ ok: true, pickupSeconds: 6, destinationSeconds: 26 });
    s = ok(advance(s, 6)).state;
    expect(rideEta(s, id)).toEqual({ ok: true, pickupSeconds: 0, destinationSeconds: 20 });
    s = ok(board(s, id)).state;
    expect(rideEta(s, id)).toEqual({ ok: true, pickupSeconds: null, destinationSeconds: 20 });
    s = ok(advance(s, 15)).state;
    expect(rideEta(s, id)).toEqual({ ok: true, pickupSeconds: null, destinationSeconds: 5 });
  });

  it("has no ETA before a cart is assigned or after the ride ends", () => {
    const { s, id } = requested();
    expect(rideEta(s, id)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    expect(rideEta(ok(cancel(s, id)).state, id)).toMatchObject({ ok: false, error: { code: "RIDE_FINISHED" } });
  });
});

describe("invariants", () => {
  it("hold after every step of a ride, and the request finds its trip", () => {
    let { s, id } = requested([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const steps: Array<(x: RideState) => RideState> = [
      (x) => ok(assignCart(x, id, "CART-01")).state,
      (x) => ok(startTrip(x, id)).state,
      (x) => ok(advance(x, 3.3)).state,
      (x) => ok(advance(x, 6.7)).state,
      (x) => ok(board(x, id)).state,
      (x) => ok(advance(x, 12.5)).state,
      (x) => ok(advance(x, 100)).state,
      (x) => ok(dropOff(x, id)).state,
    ];
    for (const f of steps) {
      s = f(s);
      expect(checkRideInvariants(s)).toEqual([]);
    }
    expect(tripForRequest(s, id)?.status).toBe("completed");
    expect(getRequest(s, id)).toMatchObject({ ok: true });
  });

  it("other carts are untouched by another cart's ride", () => {
    let { s, id } = requested([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const other = cart(s, "CART-02");
    s = ok(assignCart(s, id, "CART-01")).state;
    s = ok(startTrip(s, id)).state;
    s = ok(board(ok(advance(s, 10)).state, id)).state;
    expect(cart(s, "CART-02")).toEqual(other);
  });
});
