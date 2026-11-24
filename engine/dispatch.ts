/**
 * Deterministic dispatch for one ride request (Phase 2 Prompt 2; shared requests from Phase 4, below).
 *
 * Pure, like the rest of the engine: no timers, no randomness, no global queue. A call handles only
 * the request it is given. It never invents eligibility rules: every cart is checked by running the
 * existing `assignCart` on the current state, so a candidate is exactly a cart the engine would
 * accept (in service and idle, battery at or above the 15% reserve, a free seat, no open trip, at a
 * location rather than on a path (D10), a route to the pickup and a route to the destination, and a
 * result that passes every ride invariant). A cart the engine refuses is listed with the engine's own
 * error code and message.
 *
 * Ranking of the carts the engine accepts, compared exactly (no rounding before comparison):
 *  1. lowest time to reach the pickup: `legSecondsLeft` on the same shortest route `assignCart` plans,
 *     with the engine's speed rule min(cart speed, path speed) on each path (unrounded seconds);
 *  2. then the shortest route length to the pickup (`shortestRoute(...).lengthMeters`);
 *  3. then the cart id, in plain string order (CART-01 before CART-02).
 * Carts are evaluated in sorted id order, so the result never depends on Map insertion order.
 * The winner's state is the one `assignCart` already produced and checked; nothing else changes.
 *
 * Shared requests (Phase 4, Ghost Ride): see `dispatchShared` and SHARED_DISPATCH_POLICY. The solo
 * evaluation above runs first and unchanged; its rank-1 cart gives the rider's original solo baseline
 * (none: no join is possible). Every open trip is then evaluated by `evaluateJoin` (sharedPlan.ts),
 * joining is preferred over a new cart, and the result is still one atomic state change.
 */
import type { RideRequest, Trip } from "../shared/schemas.js";
import { shortestRoute } from "./campusGraph.js";
import { listCarts } from "./fleet.js";
import { joinTrip } from "./ghostRide.js";
import { assignCart, getRequest, legSecondsLeft, OPEN_TRIP_STATUSES, type RideError, type RideErrorCode, type RideState } from "./rides.js";
import { DELAY_EPSILON_SECONDS, evaluateJoin, MAX_ADDED_DELAY_SECONDS, type JoinExclusionCode, type RiderDelay, type SoloBaselineInput, type WorstDelay } from "./sharedPlan.js";

export const DISPATCH_POLICY =
  "Engine-eligible carts only (assignCart accepts them). Ranked by lowest exact time to reach the pickup, then shortest route distance to the pickup, then cart id.";

export interface DispatchCandidate {
  cartId: string;
  /** Whether the engine accepts this cart for the request. */
  eligible: boolean;
  /** Why not, when not eligible: the engine's error code and message from assignCart. */
  excludedCode?: RideErrorCode;
  excludedReason?: string;
  /** Exact (unrounded) seconds to reach the pickup, for eligible carts. */
  pickupEtaSeconds?: number;
  /** Route length to the pickup in meters, for eligible carts. */
  pickupDistanceMeters?: number;
  /** 1 = selected. Eligible carts only. */
  rank?: number;
}

/** Phase 4: one open trip considered for a shared request, accepted or excluded with the reason. */
export interface JoinCandidate {
  tripId: string;
  cartId: string | null;
  eligible: boolean;
  excludedCode?: JoinExclusionCode;
  excludedReason?: string;
  /** For DELAY_CAP_EXCEEDED: the rider, measure and seconds of the best sequence's worst delay. */
  worst?: WorstDelay;
  stage?: "planned" | "moving";
  /** Where the new pickup and drop-off would be inserted in the trip's stops. */
  pickupIndex?: number;
  dropOffIndex?: number;
  /** Planned stop order (location ids) after the join. */
  stopLocationIds?: string[];
  /** Every affected rider's wait and journey delay against their original baseline (planned driving time). */
  riders?: RiderDelay[];
  /** Remaining planned driving seconds from now to the joining rider's pickup. */
  joinerPickupSeconds?: number;
  remainingMeters?: number;
  sequencesChecked?: number;
  sequencesWithinCap?: number;
  /** 1 = selected. Eligible trips only. */
  rank?: number;
}

export interface DispatchSelection {
  policy: string;
  selectedCartId: string | null;
  /** Every cart in the fleet, in cart id order. */
  candidates: DispatchCandidate[];
  // ---- Present only for shared requests (Phase 4); a solo dispatch's selection is unchanged. ----
  mode?: "shared";
  /** "joined": the request joined an existing trip; "new_cart": it got its own cart; null: neither. */
  outcome?: "joined" | "new_cart" | null;
  selectedTripId?: string | null;
  /** The joining rider's original solo baseline (from the rank-1 solo cart), or null when none exists. */
  soloBaseline?: SoloBaselineInput | null;
  maxAddedDelaySeconds?: number;
  delayEpsilonSeconds?: number;
  /** Every open trip, in trip id order. */
  joinCandidates?: JoinCandidate[];
}

export type DispatchErrorCode = RideErrorCode | "NO_CART_AVAILABLE";
export interface DispatchError {
  code: DispatchErrorCode;
  message: string;
  /** Present when the request was dispatchable but no cart qualified. */
  selection?: DispatchSelection;
}

export type DispatchResult =
  | { ok: true; state: RideState; trip: Readonly<Trip>; selection: DispatchSelection }
  | { ok: false; error: DispatchError };

/** Errors that concern the request itself, not a particular cart: dispatch stops on them. */
const REQUEST_LEVEL: readonly RideErrorCode[] = ["UNKNOWN_REQUEST", "RIDE_FINISHED", "INVALID_TRANSITION"];

const failWith = (error: RideError): DispatchResult => ({ ok: false, error: { code: error.code, message: error.message } });

export const SHARED_DISPATCH_POLICY =
  `Shared ride: the rider's solo baseline comes first, from the cart solo dispatch would pick (${DISPATCH_POLICY}) and none means no join. ` +
  `Then every open trip is checked (planned trips, and moving trips nobody has boarded yet; all riders shared; battery reserve; one seat per committed rider; one student once per trip; recorded baselines; ` +
  `every affected rider's wait and journey delay within ${MAX_ADDED_DELAY_SECONDS} s of planned driving time). Joining a trip is preferred over a new cart. ` +
  `Trips rank by lowest planned time to the new rider's pickup, then shortest remaining route, then trip id.`;

type SoloEvaluation =
  | { ok: false; error: RideError }
  | { ok: true; candidates: DispatchCandidate[]; accepted: { candidate: DispatchCandidate; state: RideState; trip: Readonly<Trip> }[] };

/** Select and assign the best cart for one requested ride, or explain why none qualifies. */
export function dispatchRequest(state: RideState, requestId: string): DispatchResult {
  const req = getRequest(state, requestId);
  if (!req.ok) return failWith(req.error);
  const request = req.request;
  if (request.mode === "shared") return dispatchShared(state, request);
  const solo = evaluateSolo(state, request);
  if (!solo.ok) return failWith(solo.error);
  const { candidates, accepted } = solo;
  const best = accepted[0];
  const selection: DispatchSelection = { policy: DISPATCH_POLICY, selectedCartId: best?.candidate.cartId ?? null, candidates };
  if (!best) {
    return { ok: false, error: { code: "NO_CART_AVAILABLE", message: `No cart can take ${requestId} right now; it stays requested`, selection } };
  }
  return { ok: true, state: best.state, trip: best.trip, selection };
}

/**
 * The joining rider's original solo baseline (D2): the values recorded on the trip `assignCart` builds
 * for the rank-1 solo cart, on the current state. Independent of any shared route. Null when no cart
 * can take the ride solo right now; never a made-up or zero value.
 */
export function soloBaselineForRequest(state: RideState, requestId: string): SoloBaselineInput | null {
  const req = getRequest(state, requestId);
  if (!req.ok) return null;
  const solo = evaluateSolo(state, req.request);
  return solo.ok ? soloFrom(solo.accepted[0]?.trip) : null;
}

function soloFrom(trip: Readonly<Trip> | undefined): SoloBaselineInput | null {
  const b = trip?.passengers[0]?.baseline;
  if (!b || !Number.isFinite(b.soloPickupSeconds) || !Number.isFinite(b.soloRideSeconds)) return null;
  return { soloPickupSeconds: b.soloPickupSeconds, soloRideSeconds: b.soloRideSeconds, cartId: b.cartId };
}

/** Phase 4: dispatch a shared request (see SHARED_DISPATCH_POLICY). One atomic result, like solo dispatch. */
function dispatchShared(state: RideState, request: Readonly<RideRequest>): DispatchResult {
  const solo = evaluateSolo(state, request);
  if (!solo.ok) return failWith(solo.error);
  const bestCart = solo.accepted[0];
  const soloBaseline = soloFrom(bestCart?.trip);

  const tripIds = [...state.trips.values()].filter((t) => OPEN_TRIP_STATUSES.includes(t.status)).map((t) => t.id).sort();
  const joinCandidates: JoinCandidate[] = [];
  const eligible: JoinCandidate[] = [];
  for (const tripId of tripIds) {
    const ev = evaluateJoin(state, tripId, request, soloBaseline);
    if (!ev.ok) {
      joinCandidates.push({ tripId, cartId: ev.cartId, eligible: false, excludedCode: ev.code, excludedReason: ev.reason, ...(ev.worst ? { worst: ev.worst } : {}) });
      continue;
    }
    const p = ev.plan;
    const c: JoinCandidate = {
      tripId, cartId: p.cartId, eligible: true, stage: p.stage, pickupIndex: p.pickupIndex, dropOffIndex: p.dropOffIndex,
      stopLocationIds: p.stops.map((s) => s.locationId), riders: p.riders, joinerPickupSeconds: p.joinerPickupSeconds,
      remainingMeters: p.remainingMeters, sequencesChecked: p.sequencesChecked, sequencesWithinCap: p.sequencesWithinCap,
    };
    joinCandidates.push(c);
    eligible.push(c);
  }
  eligible.sort((a, b) => (a.joinerPickupSeconds! - b.joinerPickupSeconds!) || (a.remainingMeters! - b.remainingMeters!) || (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0));
  eligible.forEach((c, i) => { c.rank = i + 1; });

  const base = {
    policy: SHARED_DISPATCH_POLICY, candidates: solo.candidates, mode: "shared" as const, soloBaseline,
    maxAddedDelaySeconds: MAX_ADDED_DELAY_SECONDS, delayEpsilonSeconds: DELAY_EPSILON_SECONDS, joinCandidates,
  };
  const bestJoin = eligible[0];
  if (bestJoin) {
    const joined = joinTrip(state, request.id, bestJoin.tripId, soloBaseline);
    if (!joined.ok) return failWith(joined.error);
    return { ok: true, state: joined.state, trip: joined.trip, selection: { ...base, selectedCartId: bestJoin.cartId, outcome: "joined", selectedTripId: bestJoin.tripId } };
  }
  if (bestCart) {
    return { ok: true, state: bestCart.state, trip: bestCart.trip, selection: { ...base, selectedCartId: bestCart.candidate.cartId, outcome: "new_cart", selectedTripId: bestCart.trip.id } };
  }
  const selection: DispatchSelection = { ...base, selectedCartId: null, outcome: null, selectedTripId: null };
  return { ok: false, error: { code: "NO_CART_AVAILABLE", message: `No cart or shared trip can take ${request.id} right now; it stays requested`, selection } };
}

/** The solo candidate loop: every cart `assignCart` accepts, ranked by the solo policy. Commits nothing. */
function evaluateSolo(state: RideState, request: Readonly<RideRequest>): SoloEvaluation {
  const requestId = request.id;

  const carts = listCarts(state.fleet).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const candidates: DispatchCandidate[] = [];
  const accepted: { candidate: DispatchCandidate; state: RideState; trip: Readonly<Trip> }[] = [];

  for (const cart of carts) {
    const attempt = assignCart(state, requestId, cart.id);
    if (!attempt.ok) {
      if (REQUEST_LEVEL.includes(attempt.error.code)) return { ok: false, error: attempt.error };
      candidates.push({ cartId: cart.id, eligible: false, excludedCode: attempt.error.code, excludedReason: attempt.error.message });
      continue;
    }
    // assignCart succeeded, so the cart is at a location and both routes exist.
    if (cart.position.kind !== "at") return { ok: false, error: { code: "INCONSISTENT_STATE", message: `${cart.id} was accepted while on a path` } };
    const route = shortestRoute(state.graph, cart.position.locationId, request.pickupId);
    if (!route.ok) return { ok: false, error: { code: "NO_ROUTE", message: route.error.message } };
    const eta = legSecondsLeft(state.graph, cart, { locationIds: route.route.locationIds, pathIds: route.route.pathIds });
    if (!eta.ok) return { ok: false, error: eta.error };
    const candidate: DispatchCandidate = { cartId: cart.id, eligible: true, pickupEtaSeconds: eta.seconds, pickupDistanceMeters: route.route.lengthMeters };
    candidates.push(candidate);
    accepted.push({ candidate, state: attempt.state, trip: attempt.trip });
  }

  accepted.sort((a, b) =>
    a.candidate.pickupEtaSeconds! - b.candidate.pickupEtaSeconds! ||
    a.candidate.pickupDistanceMeters! - b.candidate.pickupDistanceMeters! ||
    (a.candidate.cartId < b.candidate.cartId ? -1 : a.candidate.cartId > b.candidate.cartId ? 1 : 0));
  accepted.forEach((a, i) => { a.candidate.rank = i + 1; });
  return { ok: true, candidates, accepted };
}
