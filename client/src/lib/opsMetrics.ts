/**
 * Operations Dashboard figures (Phase 3 Prompt 3), counted straight from one authoritative snapshot.
 * Cart counts, request counts and trip counts are kept apart: each uses its own entity and its own
 * status enum from shared/schemas.ts, and none is translated into another.
 *
 * Deliberately not computed: dispatch-eligible carts (only the server's dispatch decides that, using
 * battery reserve, seats, open trips, position and routes), wait times, utilization, revenue, trends.
 */
import { CartStatus, RideRequestStatus, TripStatus, type StateSnapshot } from "../../../shared/schemas";

export type Counts<K extends string> = Record<K, number>;

function countBy<K extends string>(keys: readonly K[], values: K[]): Counts<K> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Counts<K>;
  for (const v of values) out[v] += 1;
  return out;
}

export interface OpsMetrics {
  carts: { total: number; byStatus: Counts<CartStatus>; passengersOnBoard: number; seats: number };
  requests: { total: number; byStatus: Counts<RideRequestStatus>; awaitingDispatch: number; active: number };
  trips: { total: number; byStatus: Counts<TripStatus> };
  clockSeconds: number;
  revision: number;
}

export function opsMetrics(data: StateSnapshot): OpsMetrics {
  const requestsByStatus = countBy(RideRequestStatus.options, data.requests.map((r) => r.status));
  return {
    carts: {
      total: data.carts.length,
      byStatus: countBy(CartStatus.options, data.carts.map((c) => c.status)),
      passengersOnBoard: data.carts.reduce((n, c) => n + c.passengerCount, 0),
      seats: data.carts.reduce((n, c) => n + c.seats, 0),
    },
    requests: {
      total: data.requests.length,
      byStatus: requestsByStatus,
      // Requested = created, no cart yet: the only status the dispatch endpoint accepts.
      awaitingDispatch: requestsByStatus.requested,
      active: requestsByStatus.requested + requestsByStatus.assigned + requestsByStatus.arriving + requestsByStatus.on_board,
    },
    trips: { total: data.trips.length, byStatus: countBy(TripStatus.options, data.trips.map((t) => t.status)) },
    clockSeconds: data.clockSeconds,
    revision: data.revision,
  };
}

/**
 * Whether the dispatch endpoint can be asked about this request at all, from its status only.
 * "requested" means "awaiting dispatch evaluation": whether a cart can take it is decided by the server.
 * Any other status is a reason the server would refuse (reliable: it is the request's own status).
 */
export function dispatchAvailability(status: RideRequestStatus): { canAsk: true } | { canAsk: false; reason: string } {
  switch (status) {
    case "requested":
      return { canAsk: true };
    case "assigned":
    case "arriving":
    case "on_board":
      return { canAsk: false, reason: "Already has a cart." };
    case "completed":
      return { canAsk: false, reason: "Ride completed." };
    case "cancelled":
      return { canAsk: false, reason: "Ride cancelled." };
  }
}

export const CART_STATUS_TEXT: Record<CartStatus, string> = {
  idle: "Idle",
  assigned: "Assigned",
  occupied: "Occupied",
  charging: "Charging",
  offline: "Offline",
  maintenance: "Maintenance",
};

export const REQUEST_STATUS_TEXT: Record<RideRequestStatus, string> = {
  requested: "Requested",
  assigned: "Assigned",
  arriving: "Arriving",
  on_board: "On board",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const TRIP_STATUS_TEXT: Record<TripStatus, string> = {
  planned: "Planned",
  active: "Active",
  cancelling: "Cancelling",
  completed: "Completed",
  cancelled: "Cancelled",
};

// ---------- Phase 4: shared trips (display only) ----------

/**
 * Plain-language meaning of each exclusion code the server's shared dispatch can give for a trip
 * (engine/sharedPlan.ts JoinExclusionCode). Display text only: the server decided, and its own
 * reason is shown next to it.
 */
export const JOIN_EXCLUSION_TEXT: Record<string, string> = {
  SOLO_BASELINE_UNAVAILABLE: "No cart could take this ride alone right now, so there is no solo time to compare a shared trip against",
  TRIP_NOT_JOINABLE: "Trip is ending or finished",
  STAGE_NOT_ALLOWED: "Someone has already boarded (joining after boarding is not enabled)",
  TRIP_NOT_SHARED: "A rider on this trip asked for a solo ride",
  CART_INELIGIBLE: "The trip's cart cannot take another rider (status or battery reserve)",
  SAME_STUDENT: "This student is already on the trip",
  TRIP_FULL: "No free seat once committed riders are counted",
  RIDER_BASELINE_MISSING: "A rider on the trip has no recorded solo time",
  ROUTE_METRIC_UNAVAILABLE: "No route time is available for a stop",
  DELAY_CAP_EXCEEDED: "Would add more than the allowed delay for a rider",
};

/** Riders of one trip, from its passenger flags: committed (not cancelled, not dropped off) and on board. */
export function tripRiderCounts(trip: StateSnapshot["trips"][number]): { committed: number; onBoard: number; total: number } {
  return {
    committed: trip.passengers.filter((p) => !p.cancelled && !p.droppedOff).length,
    onBoard: trip.passengers.filter((p) => p.boarded && !p.droppedOff).length,
    total: trip.passengers.length,
  };
}

export const RIDER_STATE_TEXT = { waiting: "waiting", on_board: "on board", dropped_off: "dropped off", cancelled: "cancelled" } as const;
