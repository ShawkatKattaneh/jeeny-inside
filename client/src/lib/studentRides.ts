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
