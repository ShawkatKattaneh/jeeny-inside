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

export type DriverStage = "planned" | "to_pickup" | "at_pickup" | "to_destination" | "at_destination" | "cancelling" | "unknown";

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
  /** The trip's passenger request (solo trips carry exactly one), or null if it is not in the state. */
  request: RideRequest | null;
  stage: DriverStage;
  /** The next step the server would accept now, or null. */
  next: ActionBinding | null;
  /** Why no step is available right now (null when `next` is set). */
  unavailable: string | null;
}

const OPEN: readonly TripStatus[] = ["planned", "active", "cancelling"];
const at = (cart: Cart | undefined, locationId: string | undefined) => !!locationId && cart?.position.kind === "at" && cart.position.locationId === locationId;

/** Mirrors the server's preconditions for start / board / drop-off, so the UI only offers what it would accept. */
export function tripView(data: StateSnapshot, trip: Trip): CartTrip {
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
  const next = tripView(data, trip).next;
  return !!next && next.action === b.action && next.requestId === b.requestId && next.expectedStatus === b.expectedStatus;
}

export const STAGE_LABEL: Record<DriverStage, string> = {
  planned: "Assigned, not started",
  to_pickup: "Driving to pickup",
  at_pickup: "At pickup",
  to_destination: "Passenger on board",
  at_destination: "At destination",
  cancelling: "Cancelled, finishing path",
  unknown: "Waiting for details",
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
