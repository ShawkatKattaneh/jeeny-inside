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
import { RideRequest, Trip, type CampusConfig, type Cart, type TripLeg, type TripStatus } from "../shared/schemas.js";
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
  | "INCONSISTENT_STATE";

export interface RideError {
  code: RideErrorCode;
  message: string;
}

export type RideResult<T = object> = ({ ok: true; state: RideState } & T) | { ok: false; error: RideError };

export const fail = (code: RideErrorCode, message: string): { ok: false; error: RideError } => ({ ok: false, error: { code, message } });

/** Trips that still hold their cart. */
export const OPEN_TRIP_STATUSES: readonly TripStatus[] = ["planned", "active", "cancelling"];

const nowMs = (s: RideState) => Math.round(s.clockSeconds * 1000);
const pad = (n: number) => String(n).padStart(4, "0");

/** Start a ride state for one campus and its fleet. Fails if the fleet belongs to another campus or is inconsistent. */
export function createRideState(campus: CampusConfig, fleet: Fleet): RideResult {
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
  return finish(state);
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

// ---------- Operations ----------

export interface RideRequestInput {
  studentId: string;
  pickupId: string;
  destinationId: string;
  /** Only "solo" in Part 3. */
  mode?: string;
  /** Priority rides are not supported in Part 3. */
  priority?: boolean;
}

/** Create a solo ride request after checking both locations and that a route exists. */
export function createRequest(state: RideState, input: RideRequestInput): RideResult<{ request: Readonly<RideRequest> }> {
  if (!input || typeof input !== "object") return fail("INVALID_REQUEST", "A ride request needs studentId, pickupId and destinationId");
  const { studentId, pickupId, destinationId, mode = "solo", priority = false } = input;
  if (typeof studentId !== "string" || studentId.length === 0) return fail("INVALID_REQUEST", "studentId is required");
  if (mode !== "solo") return fail("INVALID_REQUEST", `Only solo rides are supported for now, not "${String(mode)}"`);
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
  const request = freezeRequest(RideRequest.parse({
    id: `REQ-${pad(state.nextRequestNo)}`, studentId, pickupId, destinationId,
    mode: "solo", priority: false, status: "requested", createdAt: t, updatedAt: t,
    fareJod: SETTINGS.fareJod, freeLoyaltyRide: false,
  }));
  return finish(withChanges(state, { requests: [request], nextRequestNo: state.nextRequestNo + 1 }), { request });
}

/**
 * Manually assign a cart, chosen by the caller, to a requested ride. Checks run in a fixed order and
 * the first failure is returned. Never lists, ranks or picks carts.
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

  const fleet = updateFleetCart(state.fleet, cartId, { status: "assigned" });
  if (!fleet.ok) return fleet;
  const trip = makeTrip({
    id: `TRIP-${pad(state.nextTripNo)}`, cartId,
    stops: [
      { locationId: request.pickupId, board: [requestId], alight: [] },
      { locationId: request.destinationId, board: [], alight: [requestId] },
    ],
    passengers: [{ requestId, boarded: false }],
    status: "planned", stopIndex: 0, leg: null,
  });
  const updated = freezeRequest({ ...request, status: "assigned", updatedAt: nowMs(state) });
  return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [trip], nextTripNo: state.nextTripNo + 1 }), { trip });
}

/** Start an assigned trip: compute the route to the pickup. The cart moves on the next `advance`. */
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
  const leg = route(state, cart.cart.position.locationId, request.pickupId);
  if (!leg.ok) return leg;

  const started = makeTrip({ ...trip, status: "active", leg: leg.leg });
  const updated = freezeRequest({ ...request, status: "arriving", updatedAt: nowMs(state) });
  return finish(withChanges(state, { requests: [updated], trips: [started] }), { trip: started });
}

/** Board the passenger. The cart must be stopped at the pickup. Passenger count changes only here and in dropOff. */
export function board(state: RideState, requestId: string): RideResult<{ trip: Readonly<Trip> }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status === "completed" || request.status === "cancelled") return fail("RIDE_FINISHED", `${requestId} is ${request.status}`);
  if (request.status !== "arriving") return fail("INVALID_TRANSITION", `${requestId} is ${request.status}; boarding needs a started trip with the cart at the pickup`);
  const trip = tripForRequest(state, requestId);
  if (!trip || trip.status !== "active" || trip.stopIndex !== 0) return fail("INCONSISTENT_STATE", `${requestId} has no active trip waiting at its pickup`);
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok) return fail("INCONSISTENT_STATE", cart.error.message);
  if (!atLocation(cart.cart, request.pickupId)) return fail("NOT_AT_STOP", `${trip.cartId} has not reached the pickup "${request.pickupId}" yet`);
  if (cart.cart.passengerCount >= cart.cart.seats) return fail("CART_INELIGIBLE", `${trip.cartId} has no free seat`);
  const leg = route(state, request.pickupId, request.destinationId);
  if (!leg.ok) return leg;

  const fleet = updateFleetCart(state.fleet, trip.cartId, { status: "occupied", passengerCount: cart.cart.passengerCount + 1 });
  if (!fleet.ok) return fleet;
  const boarded = makeTrip({
    ...trip, stopIndex: 1, leg: leg.leg,
    passengers: trip.passengers.map((p) => (p.requestId === requestId ? { ...p, boarded: true } : p)),
  });
  const updated = freezeRequest({ ...request, status: "on_board", updatedAt: nowMs(state) });
  return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [boarded] }), { trip: boarded });
}

/** Drop the passenger off. The cart must be stopped at the destination. Completes the ride and frees the cart. */
export function dropOff(state: RideState, requestId: string): RideResult<{ trip: Readonly<Trip> }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status === "completed" || request.status === "cancelled") return fail("RIDE_FINISHED", `${requestId} is ${request.status}`);
  if (request.status !== "on_board") return fail("INVALID_TRANSITION", `${requestId} is ${request.status}; drop-off needs the passenger on board`);
  const trip = tripForRequest(state, requestId);
  if (!trip || trip.status !== "active" || trip.stopIndex !== 1) return fail("INCONSISTENT_STATE", `${requestId} has no active trip heading to its destination`);
  const cart = getCart(state.fleet, trip.cartId);
  if (!cart.ok) return fail("INCONSISTENT_STATE", cart.error.message);
  if (!atLocation(cart.cart, request.destinationId)) return fail("NOT_AT_STOP", `${trip.cartId} has not reached the destination "${request.destinationId}" yet`);

  const left = cart.cart.passengerCount - 1;
  const fleet = updateFleetCart(state.fleet, trip.cartId, { status: left > 0 ? "occupied" : "idle", passengerCount: left });
  if (!fleet.ok) return fleet;
  const done = makeTrip({ ...trip, status: "completed", stopIndex: trip.stops.length, leg: null });
  const updated = freezeRequest({ ...request, status: "completed", updatedAt: nowMs(state) });
  return finish(withChanges(state, { fleet: fleet.fleet, requests: [updated], trips: [done] }), { trip: done });
}

/**
 * Cancel a ride before boarding (D3, D4).
 * - requested: the request is cancelled; no cart involved.
 * - assigned, or arriving with the cart at a location: trip cancelled, cart idle where it is.
 * - arriving with the cart mid-path: request cancelled now; trip becomes "cancelling" with a leg of
 *   only the current path; the cart stays assigned and keeps its exact progress. `advance` finishes
 *   that one path, then the trip is cancelled and the cart goes idle.
 * - on board: refused. Completed or cancelled: refused.
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

/** Exact (unrounded) seconds for `cart` to finish `leg` from where it is now. */
export function legSecondsLeft(graph: CampusGraph, cart: Readonly<Cart>, leg: TripLeg): { ok: true; seconds: number } | { ok: false; error: RideError } {
  const at = whereOnLeg(graph, cart, leg);
  if (!at.ok) return at;
  let seconds = 0;
  for (let i = at.edge; i < leg.pathIds.length; i++) {
    const p = graph.paths.get(leg.pathIds[i]!)!;
    const left = i === at.edge ? (1 - at.travelled) * p.lengthMeters : p.lengthMeters;
    seconds += left / (Math.min(cart.maxSpeedKmh, p.speedKmh) / 3.6);
  }
  return { ok: true, seconds };
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

/** Every rule that ties requests, trips and carts together. Empty when the state is consistent. */
export function checkRideInvariants(state: RideState): string[] {
  const problems: string[] = [];
  const tripByRequest = new Map<string, Readonly<Trip>>();
  const openByCart = new Map<string, Readonly<Trip>[]>();

  for (const t of state.trips.values()) {
    if (t.passengers.length !== 1 || t.stops.length !== 2) problems.push(`${t.id} is not a solo trip`);
    for (const p of t.passengers) {
      if (tripByRequest.has(p.requestId)) problems.push(`${p.requestId} is on more than one trip`);
      tripByRequest.set(p.requestId, t);
      if (!state.requests.has(p.requestId)) problems.push(`${t.id} carries unknown request ${p.requestId}`);
    }
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
    if (t.status === "completed" && t.stopIndex !== t.stops.length) problems.push(`${t.id} completed with stops left`);
  }

  for (const r of state.requests.values()) {
    const t = tripByRequest.get(r.id);
    if (t) {
      const [pickup, dest] = t.stops;
      if (pickup?.locationId !== r.pickupId) problems.push(`${t.id} pickup "${pickup?.locationId}" does not match ${r.id} pickup "${r.pickupId}"`);
      if (dest?.locationId !== r.destinationId) problems.push(`${t.id} destination "${dest?.locationId}" does not match ${r.id} destination "${r.destinationId}"`);
      if (!pickup?.board.includes(r.id)) problems.push(`${t.id} does not board ${r.id} at its pickup`);
      if (!dest?.alight.includes(r.id)) problems.push(`${t.id} does not drop off ${r.id} at its destination`);
    }
    const boarded = t?.passengers.find((p) => p.requestId === r.id)?.boarded;
    const expect = (ok: boolean, what: string) => { if (!ok) problems.push(`${r.id} is ${r.status} but ${what}`); };
    switch (r.status) {
      case "requested": expect(!t, "has a trip"); break;
      case "assigned": expect(t?.status === "planned" && boarded === false, "its trip is not planned"); break;
      case "arriving": expect(t?.status === "active" && t.stopIndex === 0 && boarded === false, "its trip is not heading to the pickup"); break;
      case "on_board": expect(t?.status === "active" && t.stopIndex === 1 && boarded === true, "its trip is not carrying it to the destination"); break;
      case "completed": expect(t?.status === "completed" && boarded === true, "its trip is not completed"); break;
      case "cancelled": expect(!t || ((t.status === "cancelling" || t.status === "cancelled") && boarded === false), "its trip is not cancelled"); break;
    }
  }

  for (const c of state.fleet.carts.values()) {
    const open = openByCart.get(c.id) ?? [];
    if (open.length > 1) problems.push(`${c.id} is on ${open.length} open trips`);
    const t = open[0];
    const boardedCount = t ? t.passengers.filter((p) => p.boarded).length : 0;
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
