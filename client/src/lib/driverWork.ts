/**
 * What Driver Mode can show, derived only from the server's ride state (Phase 3 Prompt 2).
 *
 * Driver to cart: every Cart carries `driverId` (shared/schemas.ts), set by the fleet file
 * (campus/fleets/<campus>.json) and part of every snapshot and update. A driver's cart is the cart
 * whose `driverId` equals the driver persona's id. That is the server's own field, so it is the link
 * used here. The persona also lists a `cartId` (shared/personas.ts); it is only compared, to warn when
 * the two disagree, and never used on its own.
 *
 * Driver to ride: there is NO driver-level ride assignment. Requests and trips name no driver; a trip
 * names a `cartId`. So Driver Mode shows "trips assigned to your cart" (trip.cartId === the cart above),
 * and labels them that way. A cart's `driverId` is its current driver, so finished trips are not shown
 * as this driver's work (who drove them then is not recorded).
 *
 * This is presentation only, not access control: there is no login and every socket receives the
 * whole state. Request status, trip status and cart status stay separate fields here.
 */
import type { Cart, Persona, RideRequest, StateSnapshot, Trip, TripStatus } from "../../../shared/schemas";
import type { LifecycleAction } from "./rideApi";

export interface DriverCartLink {
  /** Carts whose server-side driverId is this driver's id, in id order. */
  carts: Cart[];
  /** The cart id the demo persona lists, if any (compared only). */
  personaCartId: string | null;
  /** True when the persona lists a cart that the live fleet does not assign to this driver. */
  mismatch: boolean;
}

export function driverCartLink(data: StateSnapshot, persona: Persona): DriverCartLink {
  const carts = data.carts.filter((c) => c.driverId !== null && c.driverId === persona.id);
  const personaCartId = persona.cartId ?? null;
  return { carts, personaCartId, mismatch: personaCartId !== null && !carts.some((c) => c.id === personaCartId) };
}

export type DriverStage = "planned" | "to_pickup" | "at_pickup" | "to_destination" | "at_destination" | "cancelling" | "unknown"
  // Phase 4, shared trips: driving to the trip's next stop, or stopped at it.
  | "to_stop" | "at_stop";

/** One lifecycle step the server accepts now, bound to the exact request and trip it was derived from. */
export interface ActionBinding {
  action: LifecycleAction;
  requestId: string;
  tripId: string;
  /** The request status this action was offered for; checked again just before sending. */
  expectedStatus: RideRequest["status"];
}

export interface CartTrip {
  trip: Trip;
  /** The trip's passenger request (solo trips carry exactly one), or null if it is not in the state. Always null for a shared trip: see `shared`. */
  request: RideRequest | null;
  stage: DriverStage;
  /** The next step the server would accept now, or null. For a shared trip, the first of `actions`. */
  next: ActionBinding | null;
  /** Every step the server would accept now. A solo trip has at most one (`next`); a shared trip can have one per rider at the current stop. */
  actions: ActionBinding[];
  /** Why no step is available right now (null when `next` is set). */
  unavailable: string | null;
  /** Phase 4: the shared trip's riders and ordered stops, or null for a solo trip. */
  shared: SharedTripView | null;
}

// ---------- Phase 4: shared trips ----------

/** A rider's place in the trip, read from the trip's own passenger flags (never from being assigned alone). */
export type RiderState = "waiting" | "on_board" | "dropped_off" | "cancelled";

export interface SharedRider {
  requestId: string;
  /** From the rider's request; null if the request is not in the live state. */
  request: RideRequest | null;
  state: RiderState;
}

export interface SharedStop {
  index: number;
  locationId: string;
  /** Riders boarding / leaving here (request ids), from the server's stop list. */
  board: string[];
  alight: string[];
  /** done: before the trip's stopIndex; next: the stop the trip is serving now; later: after it. */
  status: "done" | "next" | "later";
}

export interface SharedTripView {
  riders: SharedRider[];
  stops: SharedStop[];
  /** Riders still part of the trip (not cancelled, not dropped off): the seats the trip has committed. */
  committed: number;
  /** Riders boarded and not yet dropped off. */
  onBoard: number;
  /** The cart's seats, or null if the cart is not in the state. */
  seats: number | null;
  /** The stop the trip is serving now, or null once every stop is done. */
  nextStop: SharedStop | null;
  /** True when the cart stands at `nextStop`'s location (the server's own cart position). */
  atNextStop: boolean;
}

/**
 * A trip is shown as shared when any of its riders asked to share or it carries more than one rider.
 * Solo trips (one solo rider) keep the Phase 3 view and wording unchanged.
 */
export function isSharedTrip(data: StateSnapshot, trip: Trip): boolean {
  if (trip.passengers.length > 1) return true;
  return trip.passengers.some((p) => data.requests.find((r) => r.id === p.requestId)?.mode === "shared");
}

const riderState = (p: Trip["passengers"][number]): RiderState => (p.cancelled ? "cancelled" : p.droppedOff ? "dropped_off" : p.boarded ? "on_board" : "waiting");

/**
 * The driver's view of a shared trip. Actions mirror the server's per-rider rules (engine board /
 * dropOff): a rider can be boarded or dropped off only at the trip's current stop, with the cart
 * standing there, and only if that stop lists the rider for that event and the rider's flags and
 * request status still allow it. The server re-checks everything and may refuse; nothing is changed
 * locally. There is no action to add a rider: joins happen only through the server's dispatch.
 */
function sharedTripView(data: StateSnapshot, trip: Trip): CartTrip {
  const cart = data.carts.find((c) => c.id === trip.cartId);
  const req = (id: string) => data.requests.find((r) => r.id === id) ?? null;
  const riders: SharedRider[] = trip.passengers.map((p) => ({ requestId: p.requestId, request: req(p.requestId), state: riderState(p) }));
  const stops: SharedStop[] = trip.stops.map((st, index) => ({
    index, locationId: st.locationId, board: [...st.board], alight: [...st.alight],
    status: index < trip.stopIndex ? "done" : index === trip.stopIndex ? "next" : "later",
  }));
  const nextStop = stops[trip.stopIndex] ?? null;
  const shared: SharedTripView = {
    riders, stops, nextStop,
    committed: trip.passengers.filter((p) => !p.cancelled && !p.droppedOff).length,
    onBoard: trip.passengers.filter((p) => p.boarded && !p.droppedOff).length,
    seats: cart?.seats ?? null,
    atNextStop: !!nextStop && at(cart, nextStop.locationId),
  };
  const base = { trip, request: null, shared };
  const done = (stage: DriverStage, unavailable: string): CartTrip => ({ ...base, stage, next: null, actions: [], unavailable });
  const bind = (action: LifecycleAction, r: RideRequest): ActionBinding => ({ action, requestId: r.id, tripId: trip.id, expectedStatus: r.status });

  if (trip.status === "cancelling") return done("cancelling", "The remaining waiting rider cancelled. The cart is finishing the path it was on.");
  if (!cart) return done("unknown", "This trip's details are not in the live state yet.");
  if (trip.status === "planned") {
    // Starting is one trip-level step; the server takes it through any assigned rider's request.
    const first = trip.passengers.map((p) => (p.cancelled ? null : req(p.requestId))).find((r) => r?.status === "assigned");
    if (!first) return done("unknown", "This trip's details are not in the live state yet.");
    const start = bind("start", first);
    return { ...base, stage: "planned", next: start, actions: [start], unavailable: null };
  }
  if (trip.status !== "active" || !nextStop) return done("unknown", `No driver step for a ${trip.status} trip.`);
  if (!shared.atNextStop) {
    return done("to_stop", "Boarding and drop-off open when the cart reaches the next stop. The cart moves only when the simulation advances.");
  }
  const flags = new Map(trip.passengers.map((p) => [p.requestId, p]));
  const actions: ActionBinding[] = [];
  // Drop-offs first: they free seats for riders boarding at the same stop.
  for (const id of nextStop.alight) {
    const p = flags.get(id);
    const r = req(id);
    if (p && r && p.boarded && !p.droppedOff && r.status === "on_board") actions.push(bind("drop-off", r));
  }
  for (const id of nextStop.board) {
    const p = flags.get(id);
    const r = req(id);
    if (p && r && !p.boarded && !p.cancelled && r.status === "arriving") actions.push(bind("board", r));
  }
  if (actions.length === 0) return done("at_stop", "Waiting for the live state to show this stop's riders.");
  return { ...base, stage: "at_stop", next: actions[0]!, actions, unavailable: null };
}

const OPEN: readonly TripStatus[] = ["planned", "active", "cancelling"];
const at = (cart: Cart | undefined, locationId: string | undefined) => !!locationId && cart?.position.kind === "at" && cart.position.locationId === locationId;

/** Mirrors the server's preconditions for start / board / drop-off, so the UI only offers what it would accept. */
export function tripView(data: StateSnapshot, trip: Trip): CartTrip {
  if (isSharedTrip(data, trip)) return sharedTripView(data, trip);
  return withSoloActions(soloTripView(data, trip));
}

const withSoloActions = (v: Omit<CartTrip, "actions" | "shared">): CartTrip => ({ ...v, actions: v.next ? [v.next] : [], shared: null });

/** The Phase 3 solo view, unchanged. */
function soloTripView(data: StateSnapshot, trip: Trip): Omit<CartTrip, "actions" | "shared"> {
  const requestId = trip.passengers[0]?.requestId;
  const request = data.requests.find((r) => r.id === requestId) ?? null;
  const cart = data.carts.find((c) => c.id === trip.cartId);
  const base = { trip, request };
  if (trip.status === "cancelling") {
    return { ...base, stage: "cancelling", next: null, unavailable: "The student cancelled. The cart is finishing the path it was on." };
  }
  if (!request || !cart) return { ...base, stage: "unknown", next: null, unavailable: "This trip's details are not in the live state yet." };
  const bind = (action: LifecycleAction): ActionBinding => ({ action, requestId: request.id, tripId: trip.id, expectedStatus: request.status });

  if (trip.status === "planned" && request.status === "assigned") return { ...base, stage: "planned", next: bind("start"), unavailable: null };
  if (trip.status === "active" && request.status === "arriving") {
    return at(cart, request.pickupId)
      ? { ...base, stage: "at_pickup", next: bind("board"), unavailable: null }
      : { ...base, stage: "to_pickup", next: null, unavailable: "Boarding opens when the cart reaches the pickup. The cart moves only when the simulation advances." };
  }
  if (trip.status === "active" && request.status === "on_board") {
    return at(cart, request.destinationId)
      ? { ...base, stage: "at_destination", next: bind("drop-off"), unavailable: null }
      : { ...base, stage: "to_destination", next: null, unavailable: "Drop-off opens when the cart reaches the destination. The cart moves only when the simulation advances." };
  }
  return { ...base, stage: "unknown", next: null, unavailable: `No driver step for a ${trip.status} trip with a ${request.status} ride.` };
}

/** Open trips (planned, active, cancelling) assigned to this cart, in trip-id order. No ride is pre-selected. */
export function openTripsForCart(data: StateSnapshot, cartId: string): CartTrip[] {
  return data.trips
    .filter((t) => t.cartId === cartId && OPEN.includes(t.status))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => tripView(data, t));
}

/**
 * Which trip to show: the only open trip, or the one the driver explicitly selected if it is still open.
 * With several open trips and no valid selection, none is chosen (the driver must pick).
 */
export function shownTrip(trips: CartTrip[], selectedTripId: string | null): CartTrip | null {
  if (selectedTripId) return trips.find((t) => t.trip.id === selectedTripId) ?? (trips.length === 1 ? trips[0]! : null);
  return trips.length === 1 ? trips[0]! : null;
}

/** Is this binding still exactly what the latest state offers? Prevents acting on a stale screen. */
export function bindingStillValid(data: StateSnapshot | null, b: ActionBinding): boolean {
  if (!data) return false;
  const trip = data.trips.find((t) => t.id === b.tripId);
  if (!trip) return false;
  // A solo trip offers at most one step (its `next`), so this is the Phase 3 check; a shared trip can offer one per rider.
  return tripView(data, trip).actions.some((a) => a.action === b.action && a.requestId === b.requestId && a.expectedStatus === b.expectedStatus);
}

export const STAGE_LABEL: Record<DriverStage, string> = {
  planned: "Assigned, not started",
  to_pickup: "Driving to pickup",
  at_pickup: "At pickup",
  to_destination: "Passenger on board",
  at_destination: "At destination",
  cancelling: "Cancelled, finishing path",
  unknown: "Waiting for details",
  to_stop: "Driving to the next stop",
  at_stop: "At a stop",
};

export const ACTION_LABEL: Record<LifecycleAction, string> = {
  start: "Start trip",
  board: "Confirm boarding",
  "drop-off": "Confirm drop-off",
};

export const ACTION_DONE: Record<LifecycleAction, string> = {
  start: "Trip started.",
  board: "Boarding confirmed.",
  "drop-off": "Drop-off confirmed. Ride completed.",
};

export const CART_STATUS_LABEL: Record<Cart["status"], string> = {
  idle: "Idle",
  assigned: "Assigned (no passengers)",
  occupied: "Occupied",
  charging: "Charging",
  offline: "Offline",
  maintenance: "Maintenance",
};
