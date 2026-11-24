/**
 * Campus analytics (Phase 5 Prompt 2): descriptive counts and durations over one committed ride state.
 * Pure and read-only: it only reads the state it is given and calls no ride operation. The response
 * shape, units and rules are documented in shared/analytics.ts.
 *
 * Time facts this file relies on (engine/rides.ts):
 * - Every timestamp is the simulated clock in ms (nowMs), persisted with the state.
 * - RideRequest.updatedAt is written only together with a status change. completed and cancelled are
 *   final (no operation changes such a request again), so for those two statuses updatedAt is the time
 *   the request reached that status.
 * - Boarding time is NOT kept: updatedAt equals boarding time only while the request is on_board, and
 *   is overwritten at drop-off. So request-to-boarding cannot be measured for finished rides.
 * - Tap-In (TripPassenger.tappedIn.atMs) is an arrival check-in recorded once by the server. It is not
 *   boarding and is never used as boarding.
 */
import { CartStatus, RideRequestStatus, TripStatus, type RideRequest } from "../shared/schemas.js";
import type { AnalyticsResponse, DurationStats, LocationActivity, Observation, PickupWaiting } from "../shared/analytics.js";
import { nowMs, type RideState } from "./rides.js";

const ACTIVE: readonly RideRequestStatus[] = ["requested", "assigned", "arriving", "on_board"];
/** Not yet on board: still waiting for (or at) the pickup. */
const WAITING: readonly RideRequestStatus[] = ["requested", "assigned", "arriving"];
const OUT_OF_SERVICE: readonly CartStatus[] = ["charging", "offline", "maintenance"];
const OPEN_TRIP: readonly TripStatus[] = ["planned", "active", "cancelling"];

function countBy<K extends string>(keys: readonly K[], values: K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const v of values) out[v] += 1;
  return out;
}

/** Mean, median and max of simulated durations given in ms; only finite, non-negative values are measured. */
export function durationStats(durationsMs: number[]): DurationStats {
  const valid = durationsMs.filter((d) => Number.isFinite(d) && d >= 0).map((d) => d / 1000).sort((a, b) => a - b);
  const n = valid.length;
  if (n === 0) return { status: "available", measuredRequests: 0, meanSeconds: null, medianSeconds: null, maxSeconds: null };
  const mid = Math.floor(n / 2);
  return {
    status: "available",
    measuredRequests: n,
    meanSeconds: valid.reduce((a, b) => a + b, 0) / n,
    medianSeconds: n % 2 ? valid[mid]! : (valid[mid - 1]! + valid[mid]!) / 2,
    maxSeconds: valid[n - 1]!,
  };
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);
const byCountThenId = <T extends { locationId: string; totalRequests: number }>(a: T, b: T) =>
  b.totalRequests - a.totalRequests || (a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0);

export function computeAnalytics(state: RideState, revision: number): AnalyticsResponse {
  const requests = [...state.requests.values()];
  const trips = [...state.trips.values()];
  const carts = [...state.fleet.carts.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const now = nowMs(state); // the engine's own timestamp rule, so "now" matches createdAt/updatedAt exactly
  const names = new Map(state.campus.locations.map((l) => [l.id, l.name]));
  const place = (id: string) => ({ locationId: id, name: names.get(id) ?? null, knownLocation: names.has(id) });

  // ---- Rider entries (a request's place on a trip) and Tap-In records ----
  const riders = trips.flatMap((t) => t.passengers.map((p) => ({ trip: t, p })));
  const tapInAt = new Map<string, number>();
  for (const { p } of riders) if (p.tappedIn) tapInAt.set(p.requestId, p.tappedIn.atMs);

  // ---- Demand ----
  const requestsByStatus = countBy(RideRequestStatus.options, requests.map((r) => r.status));
  const activeRequests = ACTIVE.reduce((n, s) => n + requestsByStatus[s], 0);
  const finishedRequests = requestsByStatus.completed + requestsByStatus.cancelled;

  // ---- Locations (ride requests; pickups and destinations kept separate) ----
  const activity = (key: "pickupId" | "destinationId"): LocationActivity[] => {
    const groups = new Map<string, RideRequest[]>();
    for (const r of requests) groups.set(r[key], [...(groups.get(r[key]) ?? []), r]);
    return [...groups.entries()].map(([id, rs]) => ({
      ...place(id),
      totalRequests: rs.length,
      activeRequests: rs.filter((r) => ACTIVE.includes(r.status)).length,
      completedRequests: rs.filter((r) => r.status === "completed").length,
      cancelledRequests: rs.filter((r) => r.status === "cancelled").length,
    })).sort(byCountThenId);
  };
  const pickups = activity("pickupId");
  const destinations = activity("destinationId");

  // ---- Waiting ----
  const toTapIn = (rs: RideRequest[]) => durationStats(rs.flatMap((r) => (tapInAt.has(r.id) ? [tapInAt.get(r.id)! - r.createdAt] : [])));
  const elapsed = (rs: RideRequest[]) => durationStats(rs.filter((r) => WAITING.includes(r.status)).map((r) => now - r.createdAt));
  const byPickup: PickupWaiting[] = pickups.map((p) => {
    const rs = requests.filter((r) => r.pickupId === p.locationId);
    return { locationId: p.locationId, name: p.name, knownLocation: p.knownLocation, requestToTapIn: toTapIn(rs), currentElapsedWait: elapsed(rs) };
  });
  const requestToTapIn = toTapIn(requests);
  const currentElapsedWait = elapsed(requests);
  const requestToDropOff = durationStats(requests.filter((r) => r.status === "completed").map((r) => r.updatedAt - r.createdAt));

  // ---- Fleet ----
  const cartsByStatus = countBy(CartStatus.options, carts.map((c) => c.status));
  const onBoardPassengers = carts.reduce((n, c) => n + c.passengerCount, 0);
  const totalSeats = carts.reduce((n, c) => n + c.seats, 0);
  const perCart = carts.map((c) => {
    const own = trips.filter((t) => t.cartId === c.id);
    return {
      cartId: c.id, label: c.label,
      totalTrips: own.length,
      completedTrips: own.filter((t) => t.status === "completed").length,
      cancelledTrips: own.filter((t) => t.status === "cancelled").length,
      openTrips: own.filter((t) => OPEN_TRIP.includes(t.status)).length,
      droppedOffRiders: own.reduce((n, t) => n + t.passengers.filter((p) => p.droppedOff).length, 0),
    };
  });

  // ---- Observations: plain facts about measured values, no thresholds, no diagnosis ----
  const observations: Observation[] = [];
  const HISTORY = "all records since this database was created (simulated clock)";
  const top = (list: LocationActivity[]) => list.filter((l) => l.totalRequests === list[0]?.totalRequests);
  const label = (l: { name: string | null; locationId: string }) => l.name ?? `${l.locationId} (not on this campus)`;
  if (pickups.length) {
    const t = top(pickups);
    observations.push({
      text: `Highest observed pickup volume: ${t.map(label).join(", ")} with ${t[0]!.totalRequests} of ${requests.length} ride requests${t.length > 1 ? " each" : ""}.`,
      metric: "ride requests by pickup location", population: "all ride requests, every status", window: HISTORY,
    });
  }
  if (destinations.length) {
    const t = top(destinations);
    observations.push({
      text: `Highest observed destination volume: ${t.map(label).join(", ")} with ${t[0]!.totalRequests} of ${requests.length} ride requests${t.length > 1 ? " each" : ""}.`,
      metric: "ride requests by destination", population: "all ride requests, every status", window: HISTORY,
    });
  }
  const longest = byPickup.filter((p) => p.currentElapsedWait.maxSeconds !== null).sort((a, b) => b.currentElapsedWait.maxSeconds! - a.currentElapsedWait.maxSeconds! || (a.locationId < b.locationId ? -1 : 1))[0];
  if (longest) {
    observations.push({
      text: `Longest current elapsed wait: ${Math.round(longest.currentElapsedWait.maxSeconds!)} simulated seconds, at ${label(longest)}.`,
      metric: "current elapsed wait (now minus request creation)", population: "ride requests requested, assigned or arriving", window: "now (simulated clock)",
    });
  }
  if (requestsByStatus.cancelled > 0) {
    observations.push({
      text: `${requestsByStatus.cancelled} of ${finishedRequests} finished ride requests were cancelled.`,
      metric: "cancelled share of finished requests", population: "ride requests that are completed or cancelled", window: HISTORY,
    });
  }

  return {
    revision,
    campusId: state.campus.id,
    clock: { basis: "simulated", nowSeconds: state.clockSeconds },
    coverage: {
      historyStartsAtSimulatedSeconds: 0,
      note: "History covers every ride request and trip saved in this database since it was created. Records are never deleted, so it is complete for this database, and nothing from other database files is included. All times are simulated: the clock moves only when the demo advances it.",
      calendarWindows: { status: "unavailable", reason: "Records carry only simulated-clock times, not dates or wall-clock times, so today, last 7 days and last 30 days cannot be determined." },
      demandOverTime: { status: "unavailable", reason: "The simulated clock moves only when someone advances it, so requests grouped by simulated time would show when the demo clock was moved, not when demand rose or fell." },
    },
    demand: {
      totalRequests: requests.length,
      requestsByStatus,
      activeRequests,
      finishedRequests,
      requestsByMode: { solo: requests.filter((r) => r.mode === "solo").length, shared: requests.filter((r) => r.mode === "shared").length },
      totalTrips: trips.length,
      tripsByStatus: countBy(TripStatus.options, trips.map((t) => t.status)),
      tripsWithTwoOrMoreRiders: trips.filter((t) => t.passengers.length >= 2).length,
      totalRiders: riders.length,
      droppedOffRiders: riders.filter(({ p }) => p.droppedOff).length,
      // A rider entry whose ride request is cancelled: a rider cancelled while others stayed on the trip
      // (flagged on the entry) or the only rider of a trip that was cancelled with it (not flagged).
      cancelledRiders: riders.filter(({ p }) => state.requests.get(p.requestId)?.status === "cancelled").length,
    },
    locations: { pickups, destinations },
    waiting: {
      requestToTapIn,
      requestToBoarding: { status: "unavailable", reason: "Boarding time is not saved: a request's last-update time equals its boarding time only while it is on board, and is replaced at drop-off. Tap-In is an arrival check-in, not boarding, so it is not used instead." },
      currentElapsedWait,
      requestToDropOff,
      byPickup,
    },
    fleet: {
      totalCarts: carts.length,
      cartsByStatus,
      outOfServiceCarts: OUT_OF_SERVICE.reduce((n, s) => n + cartsByStatus[s], 0),
      seatOccupancy: { status: "available", onBoardPassengers, totalSeats, ratio: ratio(onBoardPassengers, totalSeats) },
      dispatchEligibleCarts: { status: "unavailable", reason: "Dispatch eligibility depends on the specific request (routes to its pickup and destination, seats, battery reserve, open trips, position). Only a dispatch call decides it, and its result is shown per cart when Ops dispatches a request. An idle cart is not counted as eligible." },
      utilizationOverTime: { status: "unavailable", reason: "Cart status changes are not saved with times, so how long carts were busy, idle or charging cannot be measured." },
      perCart,
    },
    cancellations: {
      cancelledRequests: requestsByStatus.cancelled,
      finishedRequests,
      shareOfFinished: ratio(requestsByStatus.cancelled, finishedRequests),
      cancelledAtStage: { status: "unavailable", reason: "A cancelled request keeps only its final status, so whether it was cancelled while waiting for a cart, with a cart assigned or while the cart was arriving is not recorded." },
    },
    observations,
  };
}
