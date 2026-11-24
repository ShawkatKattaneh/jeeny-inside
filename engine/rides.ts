/**
 * Ride lifecycle (Phase 1 Part 3): solo ride requests, manual cart assignment by id, and the explicit
 * start / board / drop-off / cancel operations. Movement lives in simulation.ts.
 *
 * Pure functions over an immutable RideState, like the fleet store: every operation returns a new
 * state or an error, and never changes its input. Each result is checked against the ride
 * invariants before it is returned, so a failed operation leaves nothing half-done.
 *
 * Who owns what:
 * - RideRequest: the rider's ride (pickup, destination, lifecycle status, timestamps, fare).
 * - Trip: the cart's execution (cartId, stops, boarded flags, stopIndex, the leg being driven).
 * - Cart: physical facts (position, status, passengerCount), changed only through the fleet store.
 */
import { RideRequest, Trip, type CampusConfig, type Cart, type Path, type RiderBaseline, type TripLeg, type TripStatus } from "../shared/schemas.js";
import { SETTINGS } from "../shared/settings.js";
import { buildGraph, routeEtaSeconds, shortestRoute, type CampusGraph } from "./campusGraph.js";
import { checkCartEligibility } from "./cartRules.js";
import { getCart, updateCart, type Fleet } from "./fleet.js";

export interface RideState {
  readonly campus: CampusConfig;
  readonly graph: CampusGraph;
  readonly fleet: Fleet;
  readonly requests: ReadonlyMap<string, Readonly<RideRequest>>;
  readonly trips: ReadonlyMap<string, Readonly<Trip>>;
  /** Simulated seconds since the state was created. Only `advance` moves it. */
  readonly clockSeconds: number;
  readonly nextRequestNo: number;
  readonly nextTripNo: number;
}

export type RideErrorCode =
  | "INVALID_REQUEST"
  | "UNKNOWN_LOCATION"
  | "NOT_A_STOP"
  | "SAME_LOCATION"
  | "NO_ROUTE"
  | "UNKNOWN_REQUEST"
  | "UNKNOWN_CART"
  | "INVALID_CART_UPDATE"
  | "CART_ON_TRIP"
  | "CART_ALREADY_ASSIGNED"
  | "CART_INELIGIBLE"
  | "CART_NOT_AT_LOCATION"
  | "INVALID_TRANSITION"
  | "RIDE_FINISHED"
  | "CANNOT_CANCEL_ON_BOARD"
  | "ALREADY_CANCELLING"
  | "NOT_AT_STOP"
  | "INVALID_MOVEMENT"
  | "INCONSISTENT_STATE"
  // Phase 4 (Ghost Ride joins): why a shared request cannot join a trip.
  | "REQUEST_NOT_SHARED"
  | "TRIP_NOT_JOINABLE"
  | "STAGE_NOT_ALLOWED"
  | "TRIP_NOT_SHARED"
  | "SAME_STUDENT"
  | "TRIP_FULL"
  | "SOLO_BASELINE_UNAVAILABLE"
  | "RIDER_BASELINE_MISSING"
  | "ROUTE_METRIC_UNAVAILABLE"
  | "DELAY_CAP_EXCEEDED"
  // Phase 4 (Tap-In, engine/tapIn.ts): why a check-in at a pickup point was refused.
  | "UNKNOWN_POINT"
  | "POINT_NOT_SUPPORTED"
  | "NOT_YOUR_RIDE"
  | "TAP_IN_NOT_ALLOWED"
  | "PICKUP_MISMATCH";

export interface RideError {
  code: RideErrorCode;
  message: string;
}

export type RideResult<T = object> = ({ ok: true; state: RideState } & T) | { ok: false; error: RideError };

export const fail = (code: RideErrorCode, message: string): { ok: false; error: RideError } => ({ ok: false, error: { code, message } });

/** Trips that still hold their cart. */
export const OPEN_TRIP_STATUSES: readonly TripStatus[] = ["planned", "active", "cancelling"];

/** Server time for timestamps: simulated milliseconds since the state was created. */
export const nowMs = (s: RideState) => Math.round(s.clockSeconds * 1000);
const pad = (n: number) => String(n).padStart(4, "0");

/** Start a ride state for one campus and its fleet. Fails if the fleet belongs to another campus or is inconsistent. */
export function createRideState(campus: CampusConfig, fleet: Fleet): RideResult {
  const base = baseRideState(campus, fleet);
  return base.ok ? finish(base.state) : base;
}

/** The campus and fleet checks of createRideState, and the empty state they give (not yet checked against the ride invariants). */
function baseRideState(campus: CampusConfig, fleet: Fleet): RideResult {
  if (fleet.campusId !== campus.id) {
    return fail("INCONSISTENT_STATE", `The fleet was built for campus "${fleet.campusId}", not "${campus.id}"`);
  }
  // Matching ids are not enough: every cart position must exist on the campus actually supplied.
  const locationIds = new Set(campus.locations.map((l) => l.id));
  const paths = new Map(campus.paths.map((p) => [p.id, p]));
  for (const c of fleet.carts.values()) {
    const pos = c.position;
    if (pos.kind === "at" && !locationIds.has(pos.locationId)) {
      return fail("INCONSISTENT_STATE", `${c.id} is at "${pos.locationId}", which is not a location on the supplied campus "${campus.id}"`);
    }
    if (pos.kind === "on_path") {
      if (!paths.has(pos.pathId)) return fail("INCONSISTENT_STATE", `${c.id} is on path "${pos.pathId}", which is not a path on the supplied campus "${campus.id}"`);
      if (!(Number.isFinite(pos.progress) && pos.progress >= 0 && pos.progress <= 1)) return fail("INCONSISTENT_STATE", `${c.id} has invalid progress ${pos.progress} on path "${pos.pathId}"`);
    }
  }
  const state: RideState = Object.freeze({
    campus, graph: buildGraph(campus), fleet,
    requests: new Map(), trips: new Map(),
    clockSeconds: 0, nextRequestNo: 1, nextTripNo: 1,
  });
  return { ok: true, state };
}

/** What a saved ride state holds besides the campus and fleet (Phase 5 persistence, server/persistence.ts). */
export interface SavedRideState {
  requests: readonly unknown[];
  trips: readonly unknown[];
  clockSeconds: number;
  nextRequestNo: number;
  nextTripNo: number;
}

const savedIdNo = (id: string, prefix: string): number | null => {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  return m ? Number(m[1]) : null;
};

/**
 * Rebuild a ride state from saved data (Phase 5). Nothing is repaired, defaulted or dropped: the campus
 * and fleet get the same checks as createRideState, every request and trip is parsed with its schema,
 * ids must be unique and below the saved id counters (so new ids cannot collide), and the result must
 * pass every ride invariant. Any problem is an INCONSISTENT_STATE error naming the first one found.
 */
export function restoreRideState(campus: CampusConfig, fleet: Fleet, saved: SavedRideState): RideResult {
  // Only the campus and fleet checks here: a saved fleet may hold assigned or occupied carts whose trips
  // are added below, so the ride invariants run once, on the whole restored state.
  const base = baseRideState(campus, fleet);
  if (!base.ok) return base;
  const { clockSeconds, nextRequestNo, nextTripNo } = saved;
  if (!(Number.isFinite(clockSeconds) && clockSeconds >= 0)) return fail("INCONSISTENT_STATE", `Saved clock ${clockSeconds} is not a valid number of seconds`);
  if (!(Number.isInteger(nextRequestNo) && nextRequestNo >= 1)) return fail("INCONSISTENT_STATE", `Saved next request number ${nextRequestNo} is invalid`);
  if (!(Number.isInteger(nextTripNo) && nextTripNo >= 1)) return fail("INCONSISTENT_STATE", `Saved next trip number ${nextTripNo} is invalid`);

  const requests = new Map<string, Readonly<RideRequest>>();
  for (const raw of saved.requests) {
    const parsed = RideRequest.safeParse(raw);
    if (!parsed.success) return fail("INCONSISTENT_STATE", `A saved ride request is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const r = parsed.data;
    const no = savedIdNo(r.id, "REQ");
    if (no === null || no < 1 || no >= nextRequestNo) return fail("INCONSISTENT_STATE", `Saved ride request id "${r.id}" does not fit the saved id counter (${nextRequestNo})`);
    if (requests.has(r.id)) return fail("INCONSISTENT_STATE", `Saved ride request id "${r.id}" is used twice`);
    requests.set(r.id, freezeRequest(r));
  }
  const trips = new Map<string, Readonly<Trip>>();
  for (const raw of saved.trips) {
    const parsed = Trip.safeParse(raw);
    if (!parsed.success) return fail("INCONSISTENT_STATE", `A saved trip is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const t = parsed.data;
    const no = savedIdNo(t.id, "TRIP");
    if (no === null || no < 1 || no >= nextTripNo) return fail("INCONSISTENT_STATE", `Saved trip id "${t.id}" does not fit the saved id counter (${nextTripNo})`);
    if (trips.has(t.id)) return fail("INCONSISTENT_STATE", `Saved trip id "${t.id}" is used twice`);
    trips.set(t.id, freezeTrip(t));
  }
  return finish(Object.freeze({ ...base.state, requests, trips, clockSeconds, nextRequestNo, nextTripNo }));
}

// ---------- Lookups ----------

export function getRequest(state: RideState, requestId: string): { ok: true; request: Readonly<RideRequest> } | { ok: false; error: RideError } {
  const request = state.requests.get(requestId);
  return request ? { ok: true, request } : fail("UNKNOWN_REQUEST", `No ride request with id "${requestId}"`);
}

/** The trip carrying this request, if one was ever created. Solo rides: at most one. */
export function tripForRequest(state: RideState, requestId: string): Readonly<Trip> | undefined {
  for (const t of state.trips.values()) if (t.passengers.some((p) => p.requestId === requestId)) return t;
  return undefined;
}

/** The trip currently holding this cart (planned, active or cancelling), if any. */
export function openTripForCart(state: RideState, cartId: string): Readonly<Trip> | undefined {
  for (const t of state.trips.values()) if (t.cartId === cartId && OPEN_TRIP_STATUSES.includes(t.status)) return t;
  return undefined;
}

// ---------- Helpers shared with the simulation ----------

const freezeTrip = (t: Trip): Readonly<Trip> => {
  t.stops.forEach((s) => Object.freeze(s));
  t.passengers.forEach((p) => Object.freeze(p));
  if (t.leg) Object.freeze(t.leg);
  return Object.freeze(t);
};
const freezeRequest = (r: RideRequest): Readonly<RideRequest> => Object.freeze(r);

/** Parse and freeze a trip produced by an operation. Throws only on a programming error. */
export function makeTrip(t: unknown): Readonly<Trip> {
  return freezeTrip(Trip.parse(t));
}

/**
 * Internal (used by simulation.ts): build the next state from changed pieces, WITHOUT any checks.
 * Unchanged maps and entities are shared, not copied. Outside the engine, change state only through
 * the operations in this file (including updateCartInRide), which all run the ride invariants.
 * Note: freezing is shallow; leg arrays and the Maps are protected by read-only types, not at runtime.
 */
export function withChanges(
  state: RideState,
  changes: { fleet?: Fleet; requests?: Readonly<RideRequest>[]; trips?: Readonly<Trip>[]; clockSeconds?: number; nextRequestNo?: number; nextTripNo?: number },
): RideState {
  let requests = state.requests;
  if (changes.requests?.length) {
    const m = new Map(requests);
    for (const r of changes.requests) m.set(r.id, r);
    requests = m;
  }
  let trips = state.trips;
  if (changes.trips?.length) {
    const m = new Map(trips);
    for (const t of changes.trips) m.set(t.id, t);
    trips = m;
  }
  return Object.freeze({
    ...state,
    fleet: changes.fleet ?? state.fleet,
    requests,
    trips,
    clockSeconds: changes.clockSeconds ?? state.clockSeconds,
    nextRequestNo: changes.nextRequestNo ?? state.nextRequestNo,
    nextTripNo: changes.nextTripNo ?? state.nextTripNo,
  });
}

/** Apply a cart update through the fleet store, turning its error into a ride error. */
export function updateFleetCart(fleet: Fleet, cartId: string, patch: object): { ok: true; fleet: Fleet } | { ok: false; error: RideError } {
  const r = updateCart(fleet, cartId, patch);
  return r.ok ? { ok: true, fleet: r.fleet } : fail("INCONSISTENT_STATE", `Cart update refused: ${r.error.message}`);
}

/** Return the state only if it passes every invariant; otherwise an error (the caller keeps its old state). */
export function finish<T extends object>(state: RideState, extra?: T): RideResult<T> {
  const problems = checkRideInvariants(state);
  if (problems.length) return fail("INCONSISTENT_STATE", `Operation would break ride invariants: ${problems.join("; ")}`);
  return { ok: true, state, ...(extra as T) };
}

function route(state: RideState, from: string, to: string): { ok: true; leg: TripLeg } | { ok: false; error: RideError } {
  const r = shortestRoute(state.graph, from, to);
  if (!r.ok) return fail("NO_ROUTE", r.error.message);
  return { ok: true, leg: { locationIds: r.route.locationIds, pathIds: r.route.pathIds } };
}

const atLocation = (cart: Cart, locationId: string) => cart.position.kind === "at" && cart.position.locationId === locationId;

// ---------- Stop sequence helpers (Phase 4) ----------

type Passenger = Readonly<Trip["passengers"][number]>;

/** Index of the stop where `requestId` boards (kind "board") or leaves (kind "alight"), or -1. */
export function stopIndexOf(trip: Readonly<Trip>, requestId: string, kind: "board" | "alight"): number {
  return trip.stops.findIndex((s) => s[kind].includes(requestId));
}

/** True when every rider event at stop `i` has happened: each boarding rider boarded, each leaving rider dropped off. */
export function stopDone(trip: Readonly<Trip>, i: number): boolean {
  const stop = trip.stops[i];
  if (!stop) return false;
  const p = (id: string) => trip.passengers.find((x) => x.requestId === id);
  return stop.board.every((id) => p(id)?.boarded === true) && stop.alight.every((id) => p(id)?.droppedOff === true);
}

/** Riders still part of the trip's future: not cancelled and not dropped off. */
export const openPassengers = (trip: Readonly<Trip>): Passenger[] => trip.passengers.filter((p) => !p.cancelled && !p.droppedOff);

/**
 * A leg from where the cart is now to `targetId`. At a location: the shortest route from there. Mid-path:
 * the cart first finishes the path it is on, in the direction it is driving (taken from `currentLeg`),
 * then takes the shortest route from that path's end. The cart never turns round mid-path.
 */
export function legFromCart(graph: CampusGraph, cart: Readonly<Cart>, currentLeg: TripLeg | null, targetId: string): { ok: true; leg: TripLeg } | { ok: false; error: RideError } {
  const pos = cart.position;
  if (pos.kind === "at") {
    const r = shortestRoute(graph, pos.locationId, targetId);
    return r.ok ? { ok: true, leg: { locationIds: r.route.locationIds, pathIds: r.route.pathIds } } : fail("NO_ROUTE", r.error.message);
  }
  const i = currentLeg ? currentLeg.pathIds.indexOf(pos.pathId) : -1;
  if (!currentLeg || i === -1) return fail("INCONSISTENT_STATE", `${cart.id} is on path "${pos.pathId}", which is not on its trip's leg`);
  const from = currentLeg.locationIds[i]!;
  const end = currentLeg.locationIds[i + 1]!;
  const r = shortestRoute(graph, end, targetId);
  if (!r.ok) return fail("NO_ROUTE", r.error.message);
  return { ok: true, leg: { locationIds: [from, ...r.route.locationIds], pathIds: [pos.pathId, ...r.route.pathIds] } };
}

/**
 * After a rider event at the current stop: if that stop is now done, move to the next stop and plan the
 * leg to it from the cart's location (the cart is at the stop, since events need it there). When the
 * last stop is done the trip is completed. Returns the trip unchanged when the stop still has events.
 */
function settleStop(state: RideState, trip: Trip, cart: Readonly<Cart>): { ok: true; trip: Trip } | { ok: false; error: RideError } {
  if (trip.status !== "active" || !stopDone(trip, trip.stopIndex)) return { ok: true, trip };
  const next = trip.stopIndex + 1;
  if (next >= trip.stops.length) return { ok: true, trip: { ...trip, status: "completed", stopIndex: trip.stops.length, leg: null } };
  if (cart.position.kind !== "at") return fail("INCONSISTENT_STATE", `${cart.id} finished a stop while not at a location`);
  const leg = route(state, cart.position.locationId, trip.stops[next]!.locationId);
  if (!leg.ok) return leg;
  return { ok: true, trip: { ...trip, stopIndex: next, leg: leg.leg } };
}

/**
 * Set a cart's status and passenger count through the fleet store. When riders are dropped off mid-trip
 * and nobody is left on board but the trip still has pickups ahead, the cart goes from occupied back
 * to assigned. The cart rules allow occupied -> idle and idle -> assigned, not occupied -> assigned in
 * one step, so this is applied as those two allowed steps inside one operation; only the end result
 * is ever committed (and checked against every ride invariant).
 */
function setCartLoad(fleet: Fleet, cart: Readonly<Cart>, status: Cart["status"], passengerCount: number): { ok: true; fleet: Fleet } | { ok: false; error: RideError } {
  if (cart.status === "occupied" && status === "assigned") {
    const free = updateFleetCart(fleet, cart.id, { status: "idle", passengerCount });
    if (!free.ok) return free;
    return updateFleetCart(free.fleet, cart.id, { status: "assigned" });
  }
  return updateFleetCart(fleet, cart.id, { status, passengerCount });
}

/**
 * The original solo baseline for `request` on `cart` (D2), in unrounded planned driving seconds:
 * the time to the pickup over the same route `assignCart` plans, with the same arithmetic as
 * `legSecondsLeft` (so it equals dispatch's pickupEtaSeconds exactly), and the time from the pickup to
 * the destination at this cart's speed. Any unavailable route or non-finite value is an error, never 0.
 * `drivenSeconds` is the trip's actual-driving clock at the moment of recording.
 */
export function soloBaselineFor(state: RideState, request: Readonly<RideRequest>, cart: Readonly<Cart>, drivenSeconds: number): { ok: true; baseline: RiderBaseline } | { ok: false; error: RideError } {
  if (cart.position.kind !== "at") return fail("CART_NOT_AT_LOCATION", `${cart.id} is not at a location`);
  const toPickup = route(state, cart.position.locationId, request.pickupId);
  if (!toPickup.ok) return toPickup;
  const pickup = legSecondsLeft(state.graph, cart, toPickup.leg);
  if (!pickup.ok) return pickup;
  const toDest = route(state, request.pickupId, request.destinationId);
  if (!toDest.ok) return toDest;
  const ride = routeDrivingSeconds(state.graph, toDest.leg, cart.maxSpeedKmh);
  if (!ride.ok) return ride;
  if (!Number.isFinite(pickup.seconds) || !Number.isFinite(ride.seconds) || !Number.isFinite(drivenSeconds)) {
    return fail("SOLO_BASELINE_UNAVAILABLE", `The solo baseline for ${request.id} on ${cart.id} is not a finite number of seconds`);
  }
  const pickupMark = drivenSeconds + pickup.seconds;
  return {
    ok: true,
    baseline: {
      soloPickupSeconds: pickup.seconds, soloRideSeconds: ride.seconds,
      pickupMark, dropOffMark: pickupMark + ride.seconds,
      cartId: cart.id, recordedAtClock: state.clockSeconds,
    },
  };
}

// ---------- Operations ----------

export interface RideRequestInput {
  studentId: string;
  pickupId: string;
  destinationId: string;
  /** "solo" (default) or "shared" (Phase 4: the student opts into a Ghost Ride). */
  mode?: string;
  /** Priority rides are not supported yet. */
  priority?: boolean;
}

/** Create a solo or shared ride request after checking both locations and that a route exists. */
export function createRequest(state: RideState, input: RideRequestInput): RideResult<{ request: Readonly<RideRequest> }> {
  if (!input || typeof input !== "object") return fail("INVALID_REQUEST", "A ride request needs studentId, pickupId and destinationId");
  const { studentId, pickupId, destinationId, mode = "solo", priority = false } = input;
  if (typeof studentId !== "string" || studentId.length === 0) return fail("INVALID_REQUEST", "studentId is required");
  if (mode !== "solo" && mode !== "shared") return fail("INVALID_REQUEST", `Ride mode must be "solo" or "shared", not "${String(mode)}"`);
  if (priority !== false) return fail("INVALID_REQUEST", "Priority rides are not supported yet");
  for (const [field, id] of [["pickupId", pickupId], ["destinationId", destinationId]] as const) {
    const loc = typeof id === "string" ? state.campus.locations.find((l) => l.id === id) : undefined;
    if (!loc) return fail("UNKNOWN_LOCATION", `${field} "${String(id)}" is not a location on campus "${state.campus.id}"`);
    if (!loc.canStop) return fail("NOT_A_STOP", `${field} "${id}" is not a place where carts can stop`);
  }
  if (pickupId === destinationId) return fail("SAME_LOCATION", "Pickup and destination must differ");
  const r = route(state, pickupId, destinationId);
  if (!r.ok) return r;

  const t = nowMs(state);
  // Same simulated fare for every request, solo or shared (D8, F1): no discount and no surcharge.
  const request = freezeRequest(RideRequest.parse({
    id: `REQ-${pad(state.nextRequestNo)}`, studentId, pickupId, destinationId,
    mode, priority: false, status: "requested", createdAt: t, updatedAt: t,
    fareJod: mode === "shared" ? SETTINGS.sharedFareJod : SETTINGS.fareJod, freeLoyaltyRide: false,
  }));
  return finish(withChanges(state, { requests: [request], nextRequestNo: state.nextRequestNo + 1 }), { request });
}

/**
 * Manually assign a cart, chosen by the caller, to a requested ride. Checks run in a fixed order and
 * the first failure is returned. Never lists, ranks or picks carts. Records the rider's original solo
 * baseline (D2) on the new trip.
 */
export function assignCart(state: RideState, requestId: string, cartId: string): RideResult<{ trip: Readonly<Trip> }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status !== "requested") return fail(request.status === "completed" || request.status === "cancelled" ? "RIDE_FINISHED" : "INVALID_TRANSITION", `${requestId} is ${request.status}; only a requested ride can be assigned`);

  const found = getCart(state.fleet, cartId);
  if (!found.ok) return fail("UNKNOWN_CART", found.error.message);
  const cart = found.cart;
  const open = openTripForCart(state, cartId);
  if (open || cart.status === "assigned") {
    return fail("CART_ALREADY_ASSIGNED", `${cartId} is already on trip ${open?.id ?? "(unknown)"}${open?.status === "cancelling" ? ", finishing its path after a cancellation" : ""}`);
  }
  const elig = checkCartEligibility(cart, { seatsNeeded: 1 });
  if (!elig.eligible) return fail("CART_INELIGIBLE", elig.messages.join("; "));
  if (cart.status !== "idle") return fail("CART_INELIGIBLE", `${cartId} is ${cart.status}; only an idle cart can be assigned to a solo ride`);
  if (cart.position.kind !== "at") return fail("CART_NOT_AT_LOCATION", `${cartId} is on path "${cart.position.pathId}"; a cart must be at a location to be assigned`);
  const toPickup = route(state, cart.position.locationId, request.pickupId);
  if (!toPickup.ok) return toPickup;
  const toDest = route(state, request.pickupId, request.destinationId);
  if (!toDest.ok) return toDest;
  const baseline = soloBaselineFor(state, request, cart, 0);
  if (!baseline.ok) return baseline;

  const fleet = updateFleetCart(state.fleet, cartId, { status: "assigned" });
  if (!fleet.ok) return fleet;
  const trip = makeTrip({
    id: `TRIP-${pad(state.nextTripNo)}`, cartId,
    stops: [
      { locationId: request.pickupId, board: [requestId], alight: [] },
      { locationId: request.destinationId, board: [], alight: [requestId] },
    ],
    passengers: [{ requestId, boarded: false, droppedOff: false, cancelled: false, baseline: baseline.baseline }],
    status: "planned", stopIndex: 0, leg: null, drivenSeconds: 0,
  });
  const updated = freezeRequest({ ...request, status: "assigned", updatedAt: nowMs(state) });
  return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [trip], nextTripNo: state.nextTripNo + 1 }), { trip });
}

/**
 * Start an assigned trip: compute the route to its first stop. Every rider on the trip moves from
 * assigned to arriving (on a shared trip, all of them at once). The cart moves on the next `advance`.
 */
export function startTrip(state: RideState, requestId: string): RideResult<{ trip: Readonly<Trip> }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status === "completed" || request.status === "cancelled") return fail("RIDE_FINISHED", `${requestId} is ${request.status}`);
  if (request.status !== "assigned") return fail("INVALID_TRANSITION", `${requestId} is ${request.status}; only an assigned ride can start`);
  const trip = tripForRequest(state, requestId);
  if (!trip || trip.status !== "planned") return fail("INCONSISTENT_STATE", `${requestId} has no planned trip`);
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok) return fail("INCONSISTENT_STATE", cart.error.message);
  if (cart.cart.position.kind !== "at") return fail("CART_NOT_AT_LOCATION", `${trip.cartId} is not at a location`);
  const first = trip.stops[0];
  if (!first) return fail("INCONSISTENT_STATE", `${trip.id} has no stops`);
  const leg = route(state, cart.cart.position.locationId, first.locationId);
  if (!leg.ok) return leg;

  const started = makeTrip({ ...trip, status: "active", leg: leg.leg });
  const riders: Readonly<RideRequest>[] = [];
  for (const p of trip.passengers) {
    if (p.cancelled) continue;
    const r = state.requests.get(p.requestId);
    if (r?.status === "assigned") riders.push(freezeRequest({ ...r, status: "arriving", updatedAt: nowMs(state) }));
  }
  return finish(withChanges(state, { requests: riders, trips: [started] }), { trip: started });
}

/**
 * Board one rider. The cart must be stopped at that rider's pickup, and that pickup must be the trip's
 * current stop. Passenger count changes only here and in dropOff. When every event at the stop is done
 * the trip moves to its next stop.
 */
export function board(state: RideState, requestId: string): RideResult<{ trip: Readonly<Trip> }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status === "completed" || request.status === "cancelled") return fail("RIDE_FINISHED", `${requestId} is ${request.status}`);
  if (request.status !== "arriving") return fail("INVALID_TRANSITION", `${requestId} is ${request.status}; boarding needs a started trip with the cart at the pickup`);
  const trip = tripForRequest(state, requestId);
  const at = trip ? stopIndexOf(trip, requestId, "board") : -1;
  if (!trip || trip.status !== "active" || at === -1 || at < trip.stopIndex) return fail("INCONSISTENT_STATE", `${requestId} has no active trip waiting at its pickup`);
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok) return fail("INCONSISTENT_STATE", cart.error.message);
  if (at > trip.stopIndex) return fail("NOT_AT_STOP", `${trip.cartId} is serving earlier stops before the pickup "${request.pickupId}"`);
  if (!atLocation(cart.cart, request.pickupId)) return fail("NOT_AT_STOP", `${trip.cartId} has not reached the pickup "${request.pickupId}" yet`);
  if (cart.cart.passengerCount >= cart.cart.seats) return fail("CART_INELIGIBLE", `${trip.cartId} has no free seat`);

  const marked: Trip = { ...trip, passengers: trip.passengers.map((p) => (p.requestId === requestId ? { ...p, boarded: true } : p)) };
  const settled = settleStop(state, marked, cart.cart);
  if (!settled.ok) return settled;
  const fleet = updateFleetCart(state.fleet, trip.cartId, { status: "occupied", passengerCount: cart.cart.passengerCount + 1 });
  if (!fleet.ok) return fleet;
  const boarded = makeTrip(settled.trip);
  const updated = freezeRequest({ ...request, status: "on_board", updatedAt: nowMs(state) });
  return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [boarded] }), { trip: boarded });
}

/**
 * Drop one rider off. The cart must be stopped at that rider's destination, and it must be the trip's
 * current stop. Completes THAT rider's ride; the trip completes only when its last stop is done, and
 * the cart is freed only then (or goes back to assigned when nobody is left on board but pickups remain).
 */
export function dropOff(state: RideState, requestId: string): RideResult<{ trip: Readonly<Trip> }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status === "completed" || request.status === "cancelled") return fail("RIDE_FINISHED", `${requestId} is ${request.status}`);
  if (request.status !== "on_board") return fail("INVALID_TRANSITION", `${requestId} is ${request.status}; drop-off needs the passenger on board`);
  const trip = tripForRequest(state, requestId);
  const at = trip ? stopIndexOf(trip, requestId, "alight") : -1;
  if (!trip || trip.status !== "active" || at === -1 || at < trip.stopIndex) return fail("INCONSISTENT_STATE", `${requestId} has no active trip heading to its destination`);
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok) return fail("INCONSISTENT_STATE", cart.error.message);
  if (at > trip.stopIndex) return fail("NOT_AT_STOP", `${trip.cartId} is serving earlier stops before the destination "${request.destinationId}"`);
  if (!atLocation(cart.cart, request.destinationId)) return fail("NOT_AT_STOP", `${trip.cartId} has not reached the destination "${request.destinationId}" yet`);

  const left = cart.cart.passengerCount - 1;
  const marked: Trip = { ...trip, passengers: trip.passengers.map((p) => (p.requestId === requestId ? { ...p, droppedOff: true } : p)) };
  const settled = settleStop(state, marked, cart.cart);
  if (!settled.ok) return settled;
  const status = left > 0 ? "occupied" : settled.trip.status === "completed" ? "idle" : "assigned";
  const fleet = setCartLoad(state.fleet, cart.cart, status, left);
  if (!fleet.ok) return fleet;
  const done = makeTrip(settled.trip);
  const updated = freezeRequest({ ...request, status: "completed", updatedAt: nowMs(state) });
  return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [done] }), { trip: done });
}

/**
 * Cancel a ride before boarding (D3, D4; per rider from Phase 4, D7).
 * - requested: the request is cancelled; no cart involved.
 * - on board: refused. Completed or cancelled: refused.
 * - The only rider still on the trip (nobody else waiting, on board or already dropped off): the Part 3
 *   behaviour, unchanged. Assigned, or arriving with the cart at a location: trip cancelled, cart idle
 *   where it is. Arriving with the cart mid-path: request cancelled now; trip becomes "cancelling" with
 *   a leg of only the current path; `advance` finishes that one path, then the trip is cancelled and
 *   the cart goes idle.
 * - Other riders remain (Phase 4): only this rider is cancelled. Its stops are removed, the trip and the
 *   other riders' requests keep their states, and the leg to the next remaining stop is re-planned from
 *   the cart's position (finishing the current path first when mid-path). If nobody is left to serve
 *   (everyone else was already dropped off), the trip completes where the cart is, or finishes its
 *   current path first ("cancelling", then completed).
 * Never refused because the new route changes anyone's delay; delays are always recomputed from the
 * riders' original baselines when they are next evaluated.
 */
export function cancel(state: RideState, requestId: string): RideResult<{ trip: Readonly<Trip> | null }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  const trip = tripForRequest(state, requestId);
  if (request.status === "cancelled" && trip?.status === "cancelling") {
    return fail("ALREADY_CANCELLING", `${requestId} is already cancelled; ${trip.cartId} is finishing its current path`);
  }
  if (request.status === "completed" || request.status === "cancelled") return fail("RIDE_FINISHED", `${requestId} is ${request.status}`);
  if (request.status === "on_board") return fail("CANNOT_CANCEL_ON_BOARD", `${requestId} cannot be cancelled after boarding; the ride must be completed with a drop-off`);

  const updated = freezeRequest({ ...request, status: "cancelled", updatedAt: nowMs(state) });
  if (request.status === "requested") return finish(withChanges(state, { requests: [updated] }), { trip: null });

  if (!trip || !(trip.status === "planned" || trip.status === "active")) return fail("INCONSISTENT_STATE", `${requestId} has no open trip`);
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok) return fail("INCONSISTENT_STATE", cart.error.message);
  const others = trip.passengers.filter((p) => p.requestId !== requestId && !p.cancelled);
  if (others.length > 0) return cancelOneRider(state, trip, cart.cart, requestId, updated);
  const pos = cart.cart.position;

  if (pos.kind === "at") {
    const fleet = updateFleetCart(state.fleet, trip.cartId, { status: "idle" });
    if (!fleet.ok) return fleet;
    const cancelled = makeTrip({ ...trip, status: "cancelled", leg: null });
    return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [cancelled] }), { trip: cancelled });
  }

  // Mid-path: keep only the path the cart is on, in its current direction.
  const i = trip.leg ? trip.leg.pathIds.indexOf(pos.pathId) : -1;
  if (!trip.leg || i === -1) return fail("INCONSISTENT_STATE", `${trip.cartId} is on path "${pos.pathId}", which is not on its trip's leg`);
  const cleanupLeg = { locationIds: [trip.leg.locationIds[i]!, trip.leg.locationIds[i + 1]!], pathIds: [pos.pathId] };
  const cancelling = makeTrip({ ...trip, status: "cancelling", leg: cleanupLeg });
  return finish(withChanges(state, { requests: [updated], trips: [cancelling] }), { trip: cancelling });
}

/** Phase 4: cancel one waiting rider on a trip that has other riders (see `cancel`). */
function cancelOneRider(state: RideState, trip: Readonly<Trip>, cart: Readonly<Cart>, requestId: string, updated: Readonly<RideRequest>): RideResult<{ trip: Readonly<Trip> | null }> {
  const passengers = trip.passengers.map((p) => (p.requestId === requestId ? { ...p, cancelled: true } : p));
  // Remove the rider's events; drop stops left with no events, keeping the stop index on the same stop.
  let stopIndex = trip.stopIndex;
  const stops: Trip["stops"] = [];
  trip.stops.forEach((s, i) => {
    const kept = { ...s, board: s.board.filter((id) => id !== requestId), alight: s.alight.filter((id) => id !== requestId) };
    if (kept.board.length === 0 && kept.alight.length === 0) {
      if (i < trip.stopIndex) stopIndex -= 1;
      return;
    }
    stops.push(kept);
  });
  let next: Trip = { ...trip, passengers, stops, stopIndex };
  const stillToServe = next.passengers.some((p) => !p.cancelled && !p.droppedOff);

  if (trip.status === "planned") {
    return finish(withChanges(state, { requests: [updated], trips: [makeTrip(next)] }), { trip: makeTrip(next) });
  }

  if (!stillToServe) {
    // Everyone else was already dropped off: nothing left to serve. Nobody is on board, so the cart is assigned.
    next = { ...next, stopIndex: next.stops.length };
    const pos = cart.position;
    if (pos.kind === "at") {
      const fleet = updateFleetCart(state.fleet, cart.id, { status: "idle" });
      if (!fleet.ok) return fleet;
      const completed = makeTrip({ ...next, status: "completed", leg: null });
      return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [completed] }), { trip: completed });
    }
    const i = trip.leg ? trip.leg.pathIds.indexOf(pos.pathId) : -1;
    if (!trip.leg || i === -1) return fail("INCONSISTENT_STATE", `${cart.id} is on path "${pos.pathId}", which is not on its trip's leg`);
    const cleanupLeg = { locationIds: [trip.leg.locationIds[i]!, trip.leg.locationIds[i + 1]!], pathIds: [pos.pathId] };
    const cancelling = makeTrip({ ...next, status: "cancelling", leg: cleanupLeg });
    return finish(withChanges(state, { requests: [updated], trips: [cancelling] }), { trip: cancelling });
  }

  // Active with riders left. If the current stop is now fully handled (its remaining events already
  // happened), move on from it; the cart is standing there.
  if (stopDone(next, next.stopIndex)) {
    const settled = settleStop(state, next, cart);
    if (!settled.ok) return settled;
    next = settled.trip;
  } else {
    const target = next.stops[next.stopIndex];
    if (!target) return fail("INCONSISTENT_STATE", `${trip.id} has riders left but no stop to serve`);
    // The stop the cart was heading to is still there (it had other riders' events): keep the leg being
    // driven. Otherwise re-plan to the next remaining stop from where the cart is.
    const oldTarget = trip.stops[trip.stopIndex];
    const keptOldTarget = oldTarget !== undefined && [...oldTarget.board, ...oldTarget.alight].some((id) => id !== requestId);
    if (!keptOldTarget || !trip.leg) {
      const leg = legFromCart(state.graph, cart, trip.leg, target.locationId);
      if (!leg.ok) return leg;
      next = { ...next, leg: leg.leg };
    }
  }
  const done = makeTrip(next);
  return finish(withChanges(state, { requests: [updated], trips: [done] }), { trip: done });
}

/**
 * Update one cart inside a ride state, through the fleet store, keeping every ride rule.
 * - A cart on an open trip (planned, active or cancelling) may only have battery, range or driver
 *   changed: its position, status and passengers belong to the ride operations and the simulation.
 * - A free cart may change any operational field the fleet store allows, as long as the result is a
 *   valid ride state (for example it cannot become assigned or occupied, or sit on a path, without a trip).
 * On any failure the original state is returned unchanged.
 */
export function updateCartInRide(state: RideState, cartId: string, patch: unknown): RideResult<{ cart: Readonly<Cart> }> {
  const found = getCart(state.fleet, cartId);
  if (!found.ok) return fail("UNKNOWN_CART", found.error.message);
  const open = openTripForCart(state, cartId);
  if (open && patch && typeof patch === "object") {
    const ridesOwn = ["position", "status", "passengerCount"].filter((k) => k in patch);
    if (ridesOwn.length) {
      return fail("CART_ON_TRIP", `${cartId} is on trip ${open.id} (${open.status}); ${ridesOwn.join(", ")} can only change through the ride operations and the simulation`);
    }
  }
  const r = updateCart(state.fleet, cartId, patch);
  if (!r.ok) return fail(r.error.code === "UNKNOWN_CART" ? "UNKNOWN_CART" : "INVALID_CART_UPDATE", r.error.message);
  return finish(withChanges(state, { fleet: r.fleet }), { cart: r.cart });
}

// ---------- ETA ----------

/**
 * Whole seconds left on a trip's current leg (to the next stop, or to the end of the cleanup path),
 * using the same speed rule as routeEtaSeconds: min(cart speed, path speed) on each path.
 */
export function remainingEtaSeconds(state: RideState, tripId: string): { ok: true; seconds: number } | { ok: false; error: RideError } {
  const trip = state.trips.get(tripId);
  if (!trip) return fail("INVALID_REQUEST", `No trip with id "${tripId}"`);
  if (trip.status !== "active" && trip.status !== "cancelling") return fail("RIDE_FINISHED", `${tripId} is ${trip.status} and not driving`);
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok || !trip.leg) return fail("INCONSISTENT_STATE", `${tripId} has no cart or leg`);
  const r = legSecondsLeft(state.graph, cart.cart, trip.leg);
  return r.ok ? { ok: true, seconds: Math.round(r.seconds) } : r;
}

/**
 * The one speed rule for planned and simulated driving: a cart goes min(its own top speed, the path's
 * speed), converted from km/h to m/s. `legSecondsLeft`, `routeDrivingSeconds` and the simulation's
 * `driveLeg` all use this, so planned times and actual driving time are on the same scale.
 */
export function drivingSpeedMps(cartSpeedKmh: number, path: Pick<Path, "speedKmh">): number {
  return Math.min(cartSpeedKmh, path.speedKmh) / 3.6;
}

/** Exact (unrounded) seconds for `cart` to finish `leg` from where it is now. */
export function legSecondsLeft(graph: CampusGraph, cart: Readonly<Cart>, leg: TripLeg): { ok: true; seconds: number } | { ok: false; error: RideError } {
  const at = whereOnLeg(graph, cart, leg);
  if (!at.ok) return at;
  let seconds = 0;
  for (let i = at.edge; i < leg.pathIds.length; i++) {
    const p = graph.paths.get(leg.pathIds[i]!)!;
    const left = i === at.edge ? (1 - at.travelled) * p.lengthMeters : p.lengthMeters;
    seconds += left / drivingSpeedMps(cart.maxSpeedKmh, p);
  }
  return { ok: true, seconds };
}

/** Exact (unrounded) meters left for `cart` on `leg` from where it is now. */
export function legMetersLeft(graph: CampusGraph, cart: Readonly<Cart>, leg: TripLeg): { ok: true; meters: number } | { ok: false; error: RideError } {
  const at = whereOnLeg(graph, cart, leg);
  if (!at.ok) return at;
  let meters = 0;
  for (let i = at.edge; i < leg.pathIds.length; i++) {
    const p = graph.paths.get(leg.pathIds[i]!)!;
    meters += i === at.edge ? (1 - at.travelled) * p.lengthMeters : p.lengthMeters;
  }
  return { ok: true, meters };
}

/**
 * Exact (unrounded) planned driving seconds for a whole leg at `cartSpeedKmh`, with the same arithmetic
 * as `legSecondsLeft` from the leg's start. Unlike `routeEtaSeconds` it never rounds. An undrivable leg,
 * an invalid speed or a non-finite result is an error, never 0.
 */
export function routeDrivingSeconds(graph: CampusGraph, leg: TripLeg, cartSpeedKmh: number): { ok: true; seconds: number; meters: number } | { ok: false; error: RideError } {
  if (!(Number.isFinite(cartSpeedKmh) && cartSpeedKmh > 0)) return fail("ROUTE_METRIC_UNAVAILABLE", `Cart speed ${cartSpeedKmh} km/h cannot be used for a driving time`);
  const bad = legError(graph, leg);
  if (bad) return fail("ROUTE_METRIC_UNAVAILABLE", bad);
  let seconds = 0;
  let meters = 0;
  for (const id of leg.pathIds) {
    const p = graph.paths.get(id)!;
    seconds += p.lengthMeters / drivingSpeedMps(cartSpeedKmh, p);
    meters += p.lengthMeters;
  }
  if (!Number.isFinite(seconds) || !Number.isFinite(meters)) return fail("ROUTE_METRIC_UNAVAILABLE", "The route's driving time is not a finite number");
  return { ok: true, seconds, meters };
}

/**
 * Pickup and destination ETAs for a ride with a cart, in whole seconds.
 * Before the trip starts this is exactly routeEtaSeconds on each route; during the trip it uses the
 * cart's real position.
 */
export function rideEta(state: RideState, requestId: string): { ok: true; pickupSeconds: number | null; destinationSeconds: number } | { ok: false; error: RideError } {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status === "completed" || request.status === "cancelled") return fail("RIDE_FINISHED", `${requestId} is ${request.status}`);
  if (request.status === "requested") return fail("INVALID_TRANSITION", `${requestId} has no cart yet`);
  const trip = tripForRequest(state, requestId)!;
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok) return fail("INCONSISTENT_STATE", cart.error.message);
  const speed = cart.cart.maxSpeedKmh;
  const pickupToDest = shortestRoute(state.graph, request.pickupId, request.destinationId);
  if (!pickupToDest.ok) return fail("NO_ROUTE", pickupToDest.error.message);
  const secondLeg = routeEtaSeconds(state.graph, pickupToDest.route, speed);

  if (request.status === "assigned") {
    if (cart.cart.position.kind !== "at") return fail("INCONSISTENT_STATE", `${trip.cartId} is not at a location`);
    const toPickup = shortestRoute(state.graph, cart.cart.position.locationId, request.pickupId);
    if (!toPickup.ok) return fail("NO_ROUTE", toPickup.error.message);
    const first = routeEtaSeconds(state.graph, toPickup.route, speed);
    return { ok: true, pickupSeconds: first, destinationSeconds: first + secondLeg };
  }
  const left = remainingEtaSeconds(state, trip.id);
  if (!left.ok) return left;
  if (request.status === "arriving") return { ok: true, pickupSeconds: left.seconds, destinationSeconds: left.seconds + secondLeg };
  return { ok: true, pickupSeconds: null, destinationSeconds: left.seconds };
}

// ---------- Position on a leg ----------

/**
 * Where the cart is on the leg: the index of the path it is on (or about to drive) and the fraction
 * of that path already driven in the leg's direction. Validates that every step is a real, drivable
 * path in that direction. `edge === leg.pathIds.length` means the cart is at the leg's end.
 */
export function whereOnLeg(graph: CampusGraph, cart: Readonly<Cart>, leg: TripLeg): { ok: true; edge: number; travelled: number } | { ok: false; error: RideError } {
  const bad = legError(graph, leg);
  if (bad) return fail("INVALID_MOVEMENT", bad);
  const pos = cart.position;
  if (pos.kind === "at") {
    const idx = leg.locationIds.indexOf(pos.locationId);
    if (idx === -1) return fail("INVALID_MOVEMENT", `${cart.id} is at "${pos.locationId}", which is not on its leg`);
    return { ok: true, edge: idx, travelled: 0 };
  }
  const i = leg.pathIds.indexOf(pos.pathId);
  if (i === -1) return fail("INVALID_MOVEMENT", `${cart.id} is on path "${pos.pathId}", which is not on its leg`);
  const p = graph.paths.get(pos.pathId)!;
  const forward = p.from === leg.locationIds[i];
  return { ok: true, edge: i, travelled: forward ? pos.progress : 1 - pos.progress };
}

/** Why a leg is not drivable on this graph, or null. */
export function legError(graph: CampusGraph, leg: TripLeg): string | null {
  if (leg.locationIds.length !== leg.pathIds.length + 1) return "Leg has a mismatched number of locations and paths";
  for (let i = 0; i < leg.pathIds.length; i++) {
    const id = leg.pathIds[i]!;
    const p = graph.paths.get(id);
    const a = leg.locationIds[i]!;
    const b = leg.locationIds[i + 1]!;
    if (!p) return `Path "${id}" does not exist on this campus`;
    const forward = p.from === a && p.to === b;
    const reverse = p.from === b && p.to === a;
    if (!forward && !reverse) return `Path "${id}" does not connect "${a}" and "${b}"`;
    if (reverse && p.oneWay) return `Path "${id}" is one-way and cannot be driven from "${a}" to "${b}"`;
  }
  return null;
}

// ---------- Invariants ----------

/**
 * Every rule that ties requests, trips and carts together. Empty when the state is consistent.
 * Phase 4 generalises the Part 3 solo rules to several riders per trip: a solo trip (one rider, two
 * stops) satisfies exactly the rules it did before.
 */
export function checkRideInvariants(state: RideState): string[] {
  const problems: string[] = [];
  const tripByRequest = new Map<string, Readonly<Trip>>();
  const openByCart = new Map<string, Readonly<Trip>[]>();

  for (const t of state.trips.values()) {
    if (t.passengers.length === 0 || t.stops.length < 2) problems.push(`${t.id} needs at least one rider and two stops`);
    const ids = new Set<string>();
    for (const p of t.passengers) {
      if (ids.has(p.requestId)) problems.push(`${t.id} lists ${p.requestId} twice`);
      ids.add(p.requestId);
      if (tripByRequest.has(p.requestId)) problems.push(`${p.requestId} is on more than one trip`);
      tripByRequest.set(p.requestId, t);
      if (!state.requests.has(p.requestId)) problems.push(`${t.id} carries unknown request ${p.requestId}`);
      if (p.droppedOff && !p.boarded) problems.push(`${t.id}: ${p.requestId} was dropped off without boarding`);
      // Tap-In (Phase 4) is history: it must name a real campus location. It is deliberately not tied to the
      // current pickup here (the match is enforced when it is written), so the record is never rewritten.
      if (p.tappedIn && !state.campus.locations.some((l) => l.id === p.tappedIn!.locationId)) problems.push(`${t.id}: ${p.requestId} tapped in at unknown location "${p.tappedIn.locationId}"`);
      if (p.cancelled && p.boarded) problems.push(`${t.id}: ${p.requestId} is cancelled after boarding`);
      if (p.baseline) {
        const b = p.baseline;
        if (![b.soloPickupSeconds, b.soloRideSeconds, b.pickupMark, b.dropOffMark].every(Number.isFinite)) problems.push(`${t.id}: ${p.requestId} has a non-finite baseline`);
        if (b.dropOffMark !== b.pickupMark + b.soloRideSeconds) problems.push(`${t.id}: ${p.requestId} baseline drop-off mark does not equal pickup mark + solo ride time`);
      }
      // A rider's stops: exactly one boarding stop before exactly one drop-off stop; none once removed by a per-rider cancel.
      const boards = t.stops.flatMap((s, i) => (s.board.includes(p.requestId) ? [i] : []));
      const alights = t.stops.flatMap((s, i) => (s.alight.includes(p.requestId) ? [i] : []));
      if (p.cancelled) {
        if (boards.length || alights.length) problems.push(`${t.id} still has stops for cancelled rider ${p.requestId}`);
      } else if (boards.length !== 1 || alights.length !== 1 || boards[0]! >= alights[0]!) {
        problems.push(`${t.id} must board ${p.requestId} once and drop it off once, later`);
      }
    }
    t.stops.forEach((s, i) => {
      if (s.board.length === 0 && s.alight.length === 0) problems.push(`${t.id} stop ${i} has nobody to board or drop off`);
      for (const id of [...s.board, ...s.alight]) if (!ids.has(id)) problems.push(`${t.id} stop ${i} names ${id}, who is not on the trip`);
    });
    if (!Number.isFinite(t.drivenSeconds) || t.drivenSeconds < 0) problems.push(`${t.id} has invalid drivenSeconds ${t.drivenSeconds}`);
    if (!state.fleet.carts.has(t.cartId)) problems.push(`${t.id} uses unknown cart ${t.cartId}`);
    if (OPEN_TRIP_STATUSES.includes(t.status)) openByCart.set(t.cartId, [...(openByCart.get(t.cartId) ?? []), t]);
    const legNeeded = t.status === "active" || t.status === "cancelling";
    if (legNeeded !== (t.leg !== null)) problems.push(`${t.id} is ${t.status} but ${t.leg ? "has" : "has no"} leg`);
    if (t.leg) {
      const e = legError(state.graph, t.leg);
      if (e) problems.push(`${t.id}: ${e}`);
    }
    if (t.status === "active" && t.leg && t.leg.locationIds.at(-1) !== t.stops[t.stopIndex]?.locationId) problems.push(`${t.id} leg does not end at its next stop`);
    if (t.status === "cancelling" && t.leg && t.leg.pathIds.length !== 1) problems.push(`${t.id} cleanup leg must be exactly one path`);
    if (t.status === "planned" && (t.stopIndex !== 0 || t.passengers.some((p) => p.boarded))) problems.push(`${t.id} is planned but has started`);
    if (t.status === "active" || t.status === "completed") {
      // Stops before stopIndex are fully handled; stops after it have not started.
      t.stops.forEach((_s, i) => {
        if (i < t.stopIndex && !stopDone(t, i)) problems.push(`${t.id} passed stop ${i} with riders not handled`);
        if (i > t.stopIndex && t.stops[i]!.board.some((id) => t.passengers.find((p) => p.requestId === id)?.boarded)) problems.push(`${t.id} boarded a rider at a later stop ${i}`);
        if (i > t.stopIndex && t.stops[i]!.alight.some((id) => t.passengers.find((p) => p.requestId === id)?.droppedOff)) problems.push(`${t.id} dropped off a rider at a later stop ${i}`);
      });
    }
    if (t.status === "active" && t.stopIndex >= t.stops.length) problems.push(`${t.id} is active with no stop left`);
    if (t.status === "completed") {
      if (t.stopIndex !== t.stops.length) problems.push(`${t.id} completed with stops left`);
      if (t.passengers.some((p) => !p.cancelled && !p.droppedOff) || !t.passengers.some((p) => p.droppedOff)) problems.push(`${t.id} completed without every rider dropped off or cancelled`);
    }
    // Riders not yet on their way to a drop-off cannot be counted out of the seats: committed riders fit.
    const cart = state.fleet.carts.get(t.cartId);
    if (cart && OPEN_TRIP_STATUSES.includes(t.status) && openPassengers(t).length > cart.seats) problems.push(`${t.id} commits ${openPassengers(t).length} riders to ${cart.seats} seats`);
    // One student rides a trip at most once (cancelled entries excepted).
    const students = t.passengers.filter((p) => !p.cancelled).map((p) => state.requests.get(p.requestId)?.studentId);
    if (new Set(students).size !== students.length) problems.push(`${t.id} carries the same student twice`);
  }

  for (const r of state.requests.values()) {
    const t = tripByRequest.get(r.id);
    const p = t?.passengers.find((x) => x.requestId === r.id);
    if (t && p && !p.cancelled) {
      const bi = stopIndexOf(t, r.id, "board");
      const ai = stopIndexOf(t, r.id, "alight");
      const pickup = t.stops[bi];
      const dest = t.stops[ai];
      if (pickup && pickup.locationId !== r.pickupId) problems.push(`${t.id} pickup "${pickup.locationId}" does not match ${r.id} pickup "${r.pickupId}"`);
      if (dest && dest.locationId !== r.destinationId) problems.push(`${t.id} destination "${dest.locationId}" does not match ${r.id} destination "${r.destinationId}"`);
      if (!pickup) problems.push(`${t.id} does not board ${r.id} at its pickup`);
      if (!dest) problems.push(`${t.id} does not drop off ${r.id} at its destination`);
    }
    const bi = t && p ? stopIndexOf(t, r.id, "board") : -1;
    const ai = t && p ? stopIndexOf(t, r.id, "alight") : -1;
    const waiting = !!p && !p.boarded && !p.cancelled;
    const expect = (ok: boolean, what: string) => { if (!ok) problems.push(`${r.id} is ${r.status} but ${what}`); };
    switch (r.status) {
      case "requested": expect(!t, "has a trip"); break;
      case "assigned": expect(t?.status === "planned" && waiting, "its trip is not planned"); break;
      case "arriving": expect(t?.status === "active" && waiting && bi >= t.stopIndex, "its trip is not heading to the pickup"); break;
      case "on_board": expect(t?.status === "active" && p?.boarded === true && !p.droppedOff && ai >= t.stopIndex, "its trip is not carrying it to the destination"); break;
      case "completed": expect(!!t && p?.boarded === true && p.droppedOff === true && t.status !== "planned" && t.status !== "cancelled", "its trip is not completed"); break;
      case "cancelled": expect(!t || (p?.boarded === false && (p.cancelled || t.status === "cancelling" || t.status === "cancelled")), "its trip is not cancelled"); break;
    }
    if (p && r.status !== "cancelled" && p.cancelled) problems.push(`${r.id} is ${r.status} but its rider entry is cancelled`);
    if (p?.droppedOff && r.status !== "completed") problems.push(`${r.id} is ${r.status} but was dropped off`);
  }

  for (const c of state.fleet.carts.values()) {
    const open = openByCart.get(c.id) ?? [];
    if (open.length > 1) problems.push(`${c.id} is on ${open.length} open trips`);
    const t = open[0];
    const boardedCount = t ? t.passengers.filter((p) => p.boarded && !p.droppedOff).length : 0;
    if (c.passengerCount !== boardedCount) problems.push(`${c.id} has ${c.passengerCount} passengers but ${boardedCount} boarded`);
    if (t && boardedCount === 0 && c.status !== "assigned") problems.push(`${c.id} is on ${t.id} with nobody on board but is ${c.status}, not assigned`);
    if (t && boardedCount > 0 && c.status !== "occupied") problems.push(`${c.id} carries passengers on ${t.id} but is ${c.status}`);
    if (!t && (c.status === "assigned" || c.status === "occupied")) problems.push(`${c.id} is ${c.status} without a trip`);
    if (c.position.kind === "on_path") {
      if (!t || !t.leg || !t.leg.pathIds.includes(c.position.pathId)) problems.push(`${c.id} is on path "${c.position.pathId}" outside any trip leg`);
    }
    if (t?.status === "cancelling" && c.position.kind !== "on_path") problems.push(`${c.id} is cancelling but not on a path`);
    if (t?.leg && (t.status === "active" || t.status === "cancelling")) {
      const w = whereOnLeg(state.graph, c, t.leg);
      if (!w.ok) problems.push(w.error.message);
    }
  }
  return problems;
}
