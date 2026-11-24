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
