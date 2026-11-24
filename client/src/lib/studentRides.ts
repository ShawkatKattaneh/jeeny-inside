/**
 * What the Student App shows about a student's own rides, derived only from the server's state.
 *
 * Ownership: every RideRequest carries the studentId it was created with (POST /api/ride-requests),
 * and snapshots and updates include it. Filtering by the active demo persona's id is therefore exact.
 * It is presentation and data minimization only, NOT access control: there is no login, the server
 * does not check studentId, and every socket receives the whole ride state.
 *
 * Phases map the server's request status to student-facing labels. Two of them are read straight from
 * authoritative data rather than invented: "at_pickup" (status "arriving" and the trip's cart is at the
 * pickup location) and "at_destination" (status "on_board" and the cart is at the destination).
 * Nothing here moves a ride forward; boarding and completion appear only after the server says so.
 */
import type { CampusConfig, Cart, CartPosition, Point, RideRequest, RideRequestStatus, StateSnapshot, Trip, TripStatus } from "../../../shared/schemas";

export type RidePhase = "requested" | "assigned" | "approaching" | "at_pickup" | "in_progress" | "at_destination" | "completed" | "cancelled";

export interface StudentRide {
  request: RideRequest;
  /** The trip carrying this request, or null when there is none (yet). */
  trip: Trip | null;
  /** The trip's cart, only while the ride is active (null before assignment and after the ride ends). */
  cart: Pick<Cart, "id" | "label" | "position" | "simulated"> | null;
  /** Label of the cart that carried a finished ride, when its trip is known. */
  cartLabel: string | null;
  phase: RidePhase;
  active: boolean;
  /** False only for a just-booked request shown from the booking response before the live state has it. */
  synced: boolean;
}

const FINAL: readonly RideRequestStatus[] = ["completed", "cancelled"];
const OPEN_TRIP: readonly TripStatus[] = ["planned", "active", "cancelling"];

export const isActiveStatus = (s: RideRequestStatus) => !FINAL.includes(s);

const atLocation = (pos: CartPosition | undefined, locationId: string) => pos?.kind === "at" && pos.locationId === locationId;

export function phaseOf(request: RideRequest, trip: Trip | null, cart: Pick<Cart, "position"> | null): RidePhase {
  switch (request.status) {
    case "requested":
      return "requested";
    case "assigned":
      return "assigned";
    case "arriving":
      return trip?.status === "active" && atLocation(cart?.position, request.pickupId) ? "at_pickup" : "approaching";
    case "on_board":
      return trip?.status === "active" && atLocation(cart?.position, request.destinationId) ? "at_destination" : "in_progress";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
  }
}

/** Request ids look like REQ-0007; newest first, by creation time then id. */
function newestFirst(a: RideRequest, b: RideRequest): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The student's rides (only requests whose studentId is this student's), newest first. */
export function studentRides(data: StateSnapshot, studentId: string): StudentRide[] {
  const mine = data.requests.filter((r) => r.studentId === studentId).sort(newestFirst);
  return mine.map((request) => {
    const trip = data.trips.find((t) => t.passengers.some((p) => p.requestId === request.id)) ?? null;
    const tripCart = trip ? data.carts.find((c) => c.id === trip.cartId) ?? null : null;
    const active = isActiveStatus(request.status);
    const cart = active && trip && OPEN_TRIP.includes(trip.status) && tripCart
      ? { id: tripCart.id, label: tripCart.label, position: tripCart.position, simulated: tripCart.simulated }
      : null;
    return { request, trip, cart, cartLabel: tripCart?.label ?? null, phase: phaseOf(request, trip, cart), active, synced: true };
  });
}

/**
 * A booking response must never override the live state. The live state wins whenever it has the
 * request. Until then the response is shown as an unsynced ride with no trip or cart, in the status the
 * server returned. `pendingSeq` is the store's snapshotSeq when the response arrived: once a later
 * snapshot has replaced the state and still lacks the request (for example the server restarted), the
 * response is dropped instead of being shown forever.
 */
export function withPendingRequest(rides: StudentRide[], pending: { request: RideRequest; seq: number } | null, snapshotSeq: number, studentId: string): StudentRide[] {
  if (!pending || pending.request.studentId !== studentId) return rides;
  if (rides.some((r) => r.request.id === pending.request.id)) return rides;
  if (snapshotSeq !== pending.seq) return rides;
  const request = pending.request;
  return [{ request, trip: null, cart: null, cartLabel: null, phase: phaseOf(request, null, null), active: isActiveStatus(request.status), synced: false }, ...rides];
}

export const PHASE_LABEL: Record<RidePhase, string> = {
  requested: "Requested",
  assigned: "Cart assigned",
  approaching: "Cart on the way",
  at_pickup: "Cart at pickup",
  in_progress: "On board",
  at_destination: "Arrived",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** One line explaining the phase, using only names from the campus file and the cart's label. */
export function phaseDetail(ride: StudentRide, campus: CampusConfig): string {
  const name = (id: string) => campus.locations.find((l) => l.id === id)?.name ?? id;
  const pickup = name(ride.request.pickupId);
  const dest = name(ride.request.destinationId);
  const cart = ride.cart?.label ?? ride.cartLabel ?? "Your cart";
  switch (ride.phase) {
    case "requested":
      return "Waiting for a cart to be assigned to your ride.";
    case "assigned":
      return `${cart} is assigned. The trip to ${pickup} has not started yet.`;
    case "approaching":
      return `${cart} is heading to ${pickup}.`;
    case "at_pickup":
      return `${cart} is at ${pickup}, ready for boarding. Boarding is confirmed by the driver.`;
    case "in_progress":
      return `On board, heading to ${dest}.`;
    case "at_destination":
      return `${cart} has reached ${dest}. Waiting for the drop-off to be confirmed.`;
    case "completed":
      return `Dropped off at ${dest}.`;
    case "cancelled":
      return "This ride was cancelled.";
  }
}

/** Progress steps for the tracker, in order. at_destination shares the "On board" step. */
export const TRACK_STEPS: { phase: RidePhase; label: string }[] = [
  { phase: "requested", label: "Requested" },
  { phase: "assigned", label: "Assigned" },
  { phase: "approaching", label: "On the way" },
  { phase: "at_pickup", label: "At pickup" },
  { phase: "in_progress", label: "On board" },
  { phase: "completed", label: "Completed" },
];

export function trackStepIndex(phase: RidePhase): number {
  if (phase === "at_destination") return 4;
  return TRACK_STEPS.findIndex((s) => s.phase === phase);
}

/** Only these statuses can be cancelled by the API (before boarding). */
export const canCancel = (ride: StudentRide) => ride.synced && ["requested", "assigned", "arriving"].includes(ride.request.status);

/**
 * Where to draw the cart on the schematic map: its location's map position, or a point along the
 * path it is on, using the progress the server reports. Map units, not GPS.
 */
export function cartMapPoint(campus: CampusConfig, position: CartPosition): Point | null {
  const loc = (id: string) => campus.locations.find((l) => l.id === id)?.position ?? null;
  if (position.kind === "at") return loc(position.locationId);
  const path = campus.paths.find((p) => p.id === position.pathId);
  const a = path && loc(path.from);
  const b = path && loc(path.to);
  if (!a || !b) return null;
  return { x: a.x + (b.x - a.x) * position.progress, y: a.y + (b.y - a.y) * position.progress };
}

/** The leg the server says the cart is driving now (active trips only), for the map. */
export function routePathIds(ride: StudentRide | null): string[] {
  if (!ride || !ride.active || ride.trip?.status !== "active" || !ride.trip.leg) return [];
  return ride.trip.leg.pathIds;
}

// ---------- Phase 4: shared rides (Ghost Ride) ----------

/**
 * What a student may see about a SHARED ride's trip, read only from the server's trip and passenger
 * data. Never shows other riders' names, ids or locations: only counts, and the number of stops the
 * cart still makes before this student's own pickup and drop-off.
 *
 * `origin` comes from the trip's passenger list. The server creates a trip with exactly one passenger
 * (the dispatched request, engine assignCart) and only ever appends joining riders to it (engine
 * joinTrip); cancelled riders stay in the list with `cancelled: true`. So this request being first means
 * the trip was created for it (a new cart assignment), and being later means it joined a trip that
 * already existed. Nothing here decides or predicts a match.
 */
export interface SharedTripInfo {
  origin: "new_cart" | "joined";
  /** Other riders still part of the trip (not cancelled, not dropped off). */
  otherRiders: number;
  /** Riders on board now (boarded and not dropped off), this student included. */
  onBoard: number;
  /** Stops the cart makes before this student's pickup (0 = the pickup is the next stop); null once boarded or when the trip is not running. */
  stopsBeforePickup: number | null;
  /** Stops the cart makes before this student's drop-off; null once dropped off or when the trip is not running. */
  stopsBeforeDropOff: number | null;
}

export function sharedTripInfo(ride: StudentRide): SharedTripInfo | null {
  const { request, trip } = ride;
  if (request.mode !== "shared" || !trip) return null;
  const me = trip.passengers.findIndex((p) => p.requestId === request.id);
  if (me === -1) return null;
  const mine = trip.passengers[me]!;
  const open = (p: Trip["passengers"][number]) => !p.cancelled && !p.droppedOff;
  const running = trip.status === "planned" || trip.status === "active";
  const before = (kind: "board" | "alight") => {
    const i = trip.stops.findIndex((s) => s[kind].includes(request.id));
    return i === -1 || i < trip.stopIndex ? null : i - trip.stopIndex;
  };
  return {
    origin: me === 0 ? "new_cart" : "joined",
    otherRiders: trip.passengers.filter((p) => p.requestId !== request.id && open(p)).length,
    onBoard: trip.passengers.filter((p) => p.boarded && !p.droppedOff).length,
    stopsBeforePickup: running && !mine.boarded && !mine.cancelled ? before("board") : null,
    stopsBeforeDropOff: running && !mine.droppedOff && !mine.cancelled ? before("alight") : null,
  };
}

const stopsText = (n: number, what: string) => (n === 0 ? `Your ${what} is the next stop.` : `${n} stop${n === 1 ? "" : "s"} before your ${what}.`);

/** Short factual lines about a shared ride, for the status card. Empty for solo rides. */
export function sharedRideLines(ride: StudentRide): string[] {
  if (ride.request.mode !== "shared") return [];
  if (ride.request.status === "requested") {
    return ["You asked to share. Not matched yet: when your ride is dispatched, the server either adds it to a compatible trip or gives it its own cart."];
  }
  const info = sharedTripInfo(ride);
  if (!info) return ride.active ? ["Shared ride. Waiting for the trip details from live updates."] : [];
  const lines: string[] = [];
  if (ride.active) {
    lines.push(info.origin === "joined" ? "Your ride joined a trip that was already planned." : "A cart was assigned to your ride.");
    lines.push(info.otherRiders === 0 ? "No other riders on this trip right now." : `Sharing with ${info.otherRiders} other rider${info.otherRiders === 1 ? "" : "s"}.`);
    if (info.stopsBeforePickup !== null) lines.push(stopsText(info.stopsBeforePickup, "pickup"));
    else if (info.stopsBeforeDropOff !== null && ride.request.status === "on_board") lines.push(stopsText(info.stopsBeforeDropOff, "drop-off"));
  }
  return lines;
}

/** Shown next to "Cancel ride" on a shared ride: only this student's ride is cancelled. */
export function sharedCancelNote(ride: StudentRide): string | null {
  const info = sharedTripInfo(ride);
  if (!info || info.otherRiders === 0) return null;
  return "Cancelling removes only your ride. The trip continues for the other riders.";
}
