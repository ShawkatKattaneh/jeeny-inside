/**
 * Ghost Ride shared-plan evaluator (Phase 4). Pure: reads a ride state and returns an evaluation. It
 * never changes the state, never picks at random and never depends on Map insertion order.
 *
 * What it answers: can this shared request join this open trip, and if so with which stop sequence?
 *
 * Planned driving time vs actual driving time vs wall-clock waiting (D2):
 * - PLANNED driving time: unrounded seconds from the campus graph, with the engine's one speed rule
 *   min(cart speed, path speed) per path (`legSecondsLeft`, `routeDrivingSeconds`). Used for the solo
 *   baseline and for every candidate route.
 * - ACTUAL simulated driving time: `Trip.drivenSeconds`, grown only by `advance` while the cart moves.
 *   Used only as the common clock on which baseline marks and planned arrival marks are placed. It is
 *   never used as an estimate of a future driving time.
 * - Wall-clock waiting (time a cart stands at a stop until someone confirms boarding or drop-off) is
 *   not modelled by the engine and is not part of any figure here. Planned driving time is not a
 *   guaranteed waiting time.
 *
 * The two delay measurements, for each affected rider r (existing riders not dropped off or cancelled,
 * plus the joining rider), with D = trip.drivenSeconds and R(stop) = remaining planned driving seconds
 * from the cart's current position to that stop in the candidate sequence:
 *   waitDelay(r)    = D + R(pickup of r)   - r.baseline.pickupMark     (only while r has not boarded)
 *   journeyDelay(r) = D + R(drop-off of r) - r.baseline.dropOffMark
 * Accepted only if every value is <= MAX_ADDED_DELAY_SECONDS + DELAY_EPSILON_SECONDS. There is no lower
 * bound: negative delays are real values and are kept as they are. Nothing is rounded before comparing.
 * Delay is recomputed from the original, write-once baselines on every evaluation; no delay is stored.
 *
 * Candidate sequences (D1, D3): the existing stops keep their relative order; the new pickup is
 * inserted at position i and the new drop-off at position j > i among the stops not yet reached.
 *
 * Ranking of sequences within the cap (in this order, exact comparisons):
 *  1. lowest maximum delay among EXISTING riders (over both their wait and journey delays);
 *  2. then lowest total journey delay over all affected riders (joining rider included);
 *  3. then lowest planned drop-off time of the joining rider (R of its drop-off);
 *  4. then lowest total remaining route length in meters;
 *  5. then the smallest (i, j) in numeric order.
 */
import { SETTINGS } from "../shared/settings.js";
import type { RideRequest, RiderBaseline, Trip, TripLeg } from "../shared/schemas.js";
import { shortestRoute } from "./campusGraph.js";
import { meetsBatteryReserve } from "./cartRules.js";
import { getCart } from "./fleet.js";
import { legFromCart, legMetersLeft, legSecondsLeft, openPassengers, routeDrivingSeconds, type RideErrorCode, type RideState } from "./rides.js";

/** The approved cap (F3, D2): 4 minutes of added planned driving time, inclusive. */
export const MAX_ADDED_DELAY_SECONDS = SETTINGS.sharedMaxAddedDelayMinutes * 60;
/** The approved floating-point tolerance at the cap (D2, A2), in seconds. */
export const DELAY_EPSILON_SECONDS = 1e-9;

/**
 * Matching stages (D6). Stage 2 (planned trip) and Stage 3 (moving trip, nobody boarded yet) are on.
 * Stage 4 (a rider has already boarded) is gated OFF for this release.
 */
export const JOIN_STAGES = Object.freeze({ plannedTrip: true, movingBeforeBoarding: true, afterBoarding: false });

/** True when a delay is within the cap: delay <= cap + epsilon. Negative delays always pass. */
export function withinDelayCap(delaySeconds: number, capSeconds = MAX_ADDED_DELAY_SECONDS, epsilonSeconds = DELAY_EPSILON_SECONDS): boolean {
  return Number.isFinite(delaySeconds) && delaySeconds <= capSeconds + epsilonSeconds;
}

/** The joining rider's original solo values, established before any shared candidate is evaluated. */
export interface SoloBaselineInput {
  soloPickupSeconds: number;
  soloRideSeconds: number;
  cartId: string;
}

export type JoinExclusionCode = Extract<RideErrorCode,
  "SOLO_BASELINE_UNAVAILABLE" | "TRIP_NOT_JOINABLE" | "STAGE_NOT_ALLOWED" | "TRIP_NOT_SHARED" | "CART_INELIGIBLE" |
  "SAME_STUDENT" | "TRIP_FULL" | "RIDER_BASELINE_MISSING" | "ROUTE_METRIC_UNAVAILABLE" | "DELAY_CAP_EXCEEDED">;

export interface RiderDelay {
  requestId: string;
  joining: boolean;
  boarded: boolean;
  /** D + R(pickup); null once the rider has boarded (no pickup ahead). Never 0 as a stand-in. */
  plannedPickupMark: number | null;
  plannedDropOffMark: number;
  /** Added waiting-to-pickup driving time; null once boarded (not applicable, not zero). */
  waitDelaySeconds: number | null;
  /** Added total journey driving time. */
  journeyDelaySeconds: number;
  /** The rider's original baseline the delays were measured against. */
  baseline: RiderBaseline;
}

export interface JoinPlan {
  tripId: string;
  cartId: string;
  stage: "planned" | "moving";
  /** Where the new pickup and drop-off land in the trip's full stop list. */
  pickupIndex: number;
  dropOffIndex: number;
  stops: Trip["stops"];
  /** The leg after the join: null for a planned trip; the unchanged or re-planned leg for a moving one. */
  leg: TripLeg | null;
  keepsCurrentLeg: boolean;
  riders: RiderDelay[];
  joinerBaseline: RiderBaseline;
  maxExistingDelaySeconds: number;
  totalJourneyDelaySeconds: number;
  /** Remaining planned driving seconds from now to the joining rider's pickup and drop-off. */
  joinerPickupSeconds: number;
  joinerDropOffSeconds: number;
  remainingMeters: number;
  drivenSeconds: number;
  sequencesChecked: number;
  sequencesWithinCap: number;
}

export interface WorstDelay {
  requestId: string;
  measure: "wait" | "journey";
  seconds: number;
}

export type JoinEvaluation =
  | { ok: true; plan: JoinPlan }
  | { ok: false; tripId: string; cartId: string | null; code: JoinExclusionCode; reason: string; worst?: WorstDelay };

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

interface Sequence {
  i: number;
  j: number;
  stops: Trip["stops"];
  leg: TripLeg | null;
  keepsCurrentLeg: boolean;
  riders: RiderDelay[];
  maxExisting: number;
  maxAll: number;
  totalJourney: number;
  joinerPickup: number;
  joinerDropOff: number;
  meters: number;
  withinCap: boolean;
  worst: WorstDelay;
}

/** Strict ranking order (see the file comment). Negative = a ranks before b. */
function compareSequences(a: Sequence, b: Sequence): number {
  return (a.maxExisting - b.maxExisting) || (a.totalJourney - b.totalJourney) || (a.joinerDropOff - b.joinerDropOff) ||
    (a.meters - b.meters) || (a.i - b.i) || (a.j - b.j);
}

/**
 * Evaluate whether `request` (a shared request) can join `tripId`. Checks run in a fixed order and the
 * first failure is the reason. `joinerSolo` must come from a solo evaluation that is independent of any
 * shared route; null means it could not be computed.
 */
export function evaluateJoin(state: RideState, tripId: string, request: Readonly<RideRequest>, joinerSolo: SoloBaselineInput | null): JoinEvaluation {
  const trip = state.trips.get(tripId);
  const out = (code: JoinExclusionCode, reason: string, worst?: WorstDelay): JoinEvaluation =>
    ({ ok: false, tripId, cartId: trip?.cartId ?? null, code, reason, ...(worst ? { worst } : {}) });

  // 1. The joining rider's original solo baseline must exist before anything else is evaluated.
  if (!joinerSolo || !isFiniteNumber(joinerSolo.soloPickupSeconds) || !isFiniteNumber(joinerSolo.soloRideSeconds) || joinerSolo.soloPickupSeconds < 0 || joinerSolo.soloRideSeconds < 0) {
    return out("SOLO_BASELINE_UNAVAILABLE", `No cart can take ${request.id} solo right now, so its solo baseline cannot be computed. A shared join needs a recorded baseline for every rider.`);
  }
  if (!trip) return out("TRIP_NOT_JOINABLE", `No trip with id "${tripId}"`);
  // 2. Only planned or active trips; Stage 4 (anyone boarded) is gated off.
  if (trip.status !== "planned" && trip.status !== "active") return out("TRIP_NOT_JOINABLE", `${tripId} is ${trip.status} and cannot take new riders`);
  const anyoneBoarded = trip.passengers.some((p) => p.boarded);
  const stage = trip.status === "planned" ? "planned" : "moving";
  if (trip.status === "planned" && !JOIN_STAGES.plannedTrip) return out("STAGE_NOT_ALLOWED", `Joining a planned trip is not enabled`);
  if (trip.status === "active" && anyoneBoarded && !JOIN_STAGES.afterBoarding) return out("STAGE_NOT_ALLOWED", `${tripId} already has a rider who boarded; joining after boarding is not enabled in this release`);
  if (trip.status === "active" && !anyoneBoarded && !JOIN_STAGES.movingBeforeBoarding) return out("STAGE_NOT_ALLOWED", `Joining a moving trip is not enabled`);
  // 3. Every rider on the trip opted into sharing (D12): a solo rider is never pooled.
  const open = openPassengers(trip);
  for (const p of open) {
    const r = state.requests.get(p.requestId);
    if (r?.mode !== "shared") return out("TRIP_NOT_SHARED", `${tripId} carries ${p.requestId}, a solo ride; solo riders are never shared`);
  }
  // 4. The cart: in service for this trip and at or above the 15% battery reserve (snapshot rule, D8).
  const found = getCart(state.fleet, trip.cartId);
  if (!found.ok) return out("TRIP_NOT_JOINABLE", found.error.message);
  const cart = found.cart;
  if (cart.status !== "assigned" && cart.status !== "occupied") return out("CART_INELIGIBLE", `${cart.id} is ${cart.status}`);
  if (!meetsBatteryReserve(cart.batteryPercent)) return out("CART_INELIGIBLE", `${cart.id} battery ${cart.batteryPercent}% is below the ${SETTINGS.batteryReservePercent}% reserve`);
  // 5. One student at most once per trip (D10).
  if (open.some((p) => state.requests.get(p.requestId)?.studentId === request.studentId)) return out("SAME_STUDENT", `${request.studentId} is already riding ${tripId}`);
  // 6. Conservative seat rule (D5): committed riders (not dropped off, not cancelled) + 1 must fit.
  if (open.length + 1 > cart.seats) return out("TRIP_FULL", `${tripId} has ${open.length} committed riders for ${cart.seats} seats`);
  // 7. Every affected existing rider has a recorded, valid baseline. Never inferred.
  for (const p of open) {
    const b = p.baseline;
    if (!b || ![b.pickupMark, b.dropOffMark, b.soloPickupSeconds, b.soloRideSeconds].every(isFiniteNumber)) {
      return out("RIDER_BASELINE_MISSING", `${tripId} rider ${p.requestId} has no recorded solo baseline`);
    }
  }
  const D = trip.drivenSeconds;
  if (!isFiniteNumber(D) || D < 0) return out("ROUTE_METRIC_UNAVAILABLE", `${tripId} has no valid driven time`);

  const joinerPickupMark = D + joinerSolo.soloPickupSeconds;
  const joinerBaseline: RiderBaseline = {
    soloPickupSeconds: joinerSolo.soloPickupSeconds, soloRideSeconds: joinerSolo.soloRideSeconds,
    pickupMark: joinerPickupMark, dropOffMark: joinerPickupMark + joinerSolo.soloRideSeconds,
    cartId: joinerSolo.cartId as RiderBaseline["cartId"], recordedAtClock: state.clockSeconds,
  };

  // 8. Enumerate insertions among the stops not yet reached, preserving existing order.
  const k = trip.stopIndex;
  const done = trip.stops.slice(0, k);
  const remaining = trip.stops.slice(k);
  const n = remaining.length;
  const pickupStop = { locationId: request.pickupId, board: [request.id], alight: [] as string[] };
  const dropStop = { locationId: request.destinationId, board: [] as string[], alight: [request.id] };

  const hop = new Map<string, { seconds: number; meters: number } | string>();
  const hopTime = (a: string, b: string): { seconds: number; meters: number } | string => {
    const key = `${a}|${b}`;
    const cached = hop.get(key);
    if (cached !== undefined) return cached;
    const r = shortestRoute(state.graph, a, b);
    let v: { seconds: number; meters: number } | string;
    if (!r.ok) v = r.error.message;
    else {
      const t = routeDrivingSeconds(state.graph, { locationIds: r.route.locationIds, pathIds: r.route.pathIds }, cart.maxSpeedKmh);
      v = t.ok ? { seconds: t.seconds, meters: t.meters } : t.error.message;
    }
    hop.set(key, v);
    return v;
  };

  let best: Sequence | null = null;
  let bestOver: Sequence | null = null;
  let checked = 0;
  let within = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = i + 1; j <= n + 1; j++) {
      checked += 1;
      const seq = [...remaining];
      seq.splice(i, 0, pickupStop);
      seq.splice(j, 0, dropStop);

      // First leg: from the cart's current position to the first remaining stop.
      let leg: TripLeg | null = null;
      let keepsCurrentLeg = false;
      let first: { seconds: number; meters: number };
      if (trip.status === "planned") {
        if (cart.position.kind !== "at") return out("ROUTE_METRIC_UNAVAILABLE", `${cart.id} is not at a location`);
        const t = hopTime(cart.position.locationId, seq[0]!.locationId);
        if (typeof t === "string") return out("ROUTE_METRIC_UNAVAILABLE", t);
        first = t;
      } else {
        if (!trip.leg) return out("ROUTE_METRIC_UNAVAILABLE", `${tripId} is active without a leg`);
        if (i > 0) {
          // The current target stays first: the leg being driven is kept as it is.
          leg = trip.leg;
          keepsCurrentLeg = true;
        } else {
          const l = legFromCart(state.graph, cart, trip.leg, seq[0]!.locationId);
          if (!l.ok) return out("ROUTE_METRIC_UNAVAILABLE", l.error.message);
          leg = l.leg;
        }
        const s = legSecondsLeft(state.graph, cart, leg);
        const m = legMetersLeft(state.graph, cart, leg);
        if (!s.ok) return out("ROUTE_METRIC_UNAVAILABLE", s.error.message);
        if (!m.ok) return out("ROUTE_METRIC_UNAVAILABLE", m.error.message);
        first = { seconds: s.seconds, meters: m.meters };
      }
      const R: number[] = [first.seconds];
      let meters = first.meters;
      for (let m = 1; m < seq.length; m++) {
        const t = hopTime(seq[m - 1]!.locationId, seq[m]!.locationId);
        if (typeof t === "string") return out("ROUTE_METRIC_UNAVAILABLE", t);
        R.push(R[m - 1]! + t.seconds);
        meters += t.meters;
      }
      if (!R.every(isFiniteNumber) || !isFiniteNumber(meters)) return out("ROUTE_METRIC_UNAVAILABLE", `A planned driving time for ${tripId} is not a finite number`);

      // Delays for every affected rider, from their original baselines.
      const riders: RiderDelay[] = [];
      for (const p of open) {
        const b = p.baseline!;
        const pi = seq.findIndex((s) => s.board.includes(p.requestId));
        const di = seq.findIndex((s) => s.alight.includes(p.requestId));
        if (di === -1 || (!p.boarded && pi === -1)) return out("ROUTE_METRIC_UNAVAILABLE", `${tripId} has no remaining stop for ${p.requestId}`);
        const plannedPickupMark = p.boarded ? null : D + R[pi]!;
        const plannedDropOffMark = D + R[di]!;
        riders.push({
          requestId: p.requestId, joining: false, boarded: p.boarded,
          plannedPickupMark, plannedDropOffMark,
          waitDelaySeconds: plannedPickupMark === null ? null : plannedPickupMark - b.pickupMark,
          journeyDelaySeconds: plannedDropOffMark - b.dropOffMark,
          baseline: b,
        });
      }
      const jPickup = D + R[i]!;
      const jDrop = D + R[j]!;
      riders.push({
        requestId: request.id, joining: true, boarded: false,
        plannedPickupMark: jPickup, plannedDropOffMark: jDrop,
        waitDelaySeconds: jPickup - joinerBaseline.pickupMark,
        journeyDelaySeconds: jDrop - joinerBaseline.dropOffMark,
        baseline: joinerBaseline,
      });

      const values: WorstDelay[] = riders.flatMap((r) => [
        ...(r.waitDelaySeconds === null ? [] : [{ requestId: r.requestId, measure: "wait" as const, seconds: r.waitDelaySeconds }]),
        { requestId: r.requestId, measure: "journey" as const, seconds: r.journeyDelaySeconds },
      ]);
      if (!values.every((v) => isFiniteNumber(v.seconds))) return out("ROUTE_METRIC_UNAVAILABLE", `A delay for ${tripId} is not a finite number`);
      const existing = values.filter((v) => v.requestId !== request.id);
      // The worst value, first in rider order on equal seconds.
      const worst = values.reduce((w, v) => (v.seconds > w.seconds ? v : w));
      const candidate: Sequence = {
        i, j, stops: [...done, ...seq], leg, keepsCurrentLeg, riders,
        maxExisting: existing.reduce((m, v) => Math.max(m, v.seconds), -Infinity),
        maxAll: worst.seconds,
        totalJourney: riders.reduce((sum, r) => sum + r.journeyDelaySeconds, 0),
        joinerPickup: R[i]!, joinerDropOff: R[j]!, meters,
        withinCap: values.every((v) => withinDelayCap(v.seconds)),
        worst,
      };
      if (candidate.withinCap) {
        within += 1;
        if (!best || compareSequences(candidate, best) < 0) best = candidate;
      } else if (!bestOver || candidate.maxAll < bestOver.maxAll) {
        bestOver = candidate;
      }
    }
  }

  if (!best) {
    const w = bestOver!.worst;
    return out("DELAY_CAP_EXCEEDED", `Every way to add ${request.id} to ${tripId} breaks the ${MAX_ADDED_DELAY_SECONDS} s cap; the best adds ${w.seconds} s to ${w.requestId}'s ${w.measure === "wait" ? "wait before pickup" : "journey"}`, w);
  }
  return {
    ok: true,
    plan: {
      tripId, cartId: cart.id, stage,
      pickupIndex: k + best.i, dropOffIndex: k + best.j,
      stops: best.stops, leg: best.leg, keepsCurrentLeg: best.keepsCurrentLeg,
      riders: best.riders, joinerBaseline,
      maxExistingDelaySeconds: best.maxExisting, totalJourneyDelaySeconds: best.totalJourney,
      joinerPickupSeconds: best.joinerPickup, joinerDropOffSeconds: best.joinerDropOff,
      remainingMeters: best.meters, drivenSeconds: D,
      sequencesChecked: checked, sequencesWithinCap: within,
    },
  };
}

/** A rider's delays on the trip's CURRENT plan (no join), recomputed from the original baseline. */
export interface CurrentRiderDelay {
  requestId: string;
  boarded: boolean;
  /** Null once boarded (not applicable). */
  waitDelaySeconds: number | null;
  journeyDelaySeconds: number;
}

/**
 * Every open rider's wait and journey delay on the trip's current plan, from the cart's position now:
 * D + R(stop) - baseline mark, the same equations `evaluateJoin` uses. For inspection (for example after
 * a cancellation re-plan); it never changes anything. Riders without a baseline, or any unavailable
 * route metric, give an error: a delay is never reported as 0 in their place.
 */
export function currentDelays(state: RideState, tripId: string): { ok: true; riders: CurrentRiderDelay[] } | { ok: false; code: "TRIP_NOT_JOINABLE" | "RIDER_BASELINE_MISSING" | "ROUTE_METRIC_UNAVAILABLE"; reason: string } {
  const trip = state.trips.get(tripId);
  if (!trip || (trip.status !== "planned" && trip.status !== "active")) return { ok: false, code: "TRIP_NOT_JOINABLE", reason: `${tripId} is not planned or active` };
  const found = getCart(state.fleet, trip.cartId);
  if (!found.ok) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: found.error.message };
  const cart = found.cart;
  const seq = trip.stops.slice(trip.stopIndex);
  if (seq.length === 0) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: `${tripId} has no remaining stop` };
  let first: number;
  if (trip.status === "planned") {
    if (cart.position.kind !== "at") return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: `${cart.id} is not at a location` };
    const r = shortestRoute(state.graph, cart.position.locationId, seq[0]!.locationId);
    if (!r.ok) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: r.error.message };
    const t = routeDrivingSeconds(state.graph, { locationIds: r.route.locationIds, pathIds: r.route.pathIds }, cart.maxSpeedKmh);
    if (!t.ok) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: t.error.message };
    first = t.seconds;
  } else {
    if (!trip.leg) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: `${tripId} is active without a leg` };
    const t = legSecondsLeft(state.graph, cart, trip.leg);
    if (!t.ok) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: t.error.message };
    first = t.seconds;
  }
  const R = [first];
  for (let m = 1; m < seq.length; m++) {
    const r = shortestRoute(state.graph, seq[m - 1]!.locationId, seq[m]!.locationId);
    if (!r.ok) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: r.error.message };
    const t = routeDrivingSeconds(state.graph, { locationIds: r.route.locationIds, pathIds: r.route.pathIds }, cart.maxSpeedKmh);
    if (!t.ok) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: t.error.message };
    R.push(R[m - 1]! + t.seconds);
  }
  const D = trip.drivenSeconds;
  const riders: CurrentRiderDelay[] = [];
  for (const p of openPassengers(trip)) {
    const b = p.baseline;
    if (!b) return { ok: false, code: "RIDER_BASELINE_MISSING", reason: `${tripId} rider ${p.requestId} has no recorded solo baseline` };
    const pi = seq.findIndex((s) => s.board.includes(p.requestId));
    const di = seq.findIndex((s) => s.alight.includes(p.requestId));
    if (di === -1 || (!p.boarded && pi === -1)) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: `${tripId} has no remaining stop for ${p.requestId}` };
    const wait = p.boarded ? null : D + R[pi]! - b.pickupMark;
    const journey = D + R[di]! - b.dropOffMark;
    if ((wait !== null && !Number.isFinite(wait)) || !Number.isFinite(journey)) return { ok: false, code: "ROUTE_METRIC_UNAVAILABLE", reason: `A delay for ${tripId} is not a finite number` };
    riders.push({ requestId: p.requestId, boarded: p.boarded, waitDelaySeconds: wait, journeyDelaySeconds: journey });
  }
  return { ok: true, riders };
}
