/**
 * Deterministic dispatch for one solo ride request (Phase 2 Prompt 2).
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
 */
import type { Trip } from "../shared/schemas.js";
import { shortestRoute } from "./campusGraph.js";
import { listCarts } from "./fleet.js";
import { assignCart, getRequest, legSecondsLeft, type RideError, type RideErrorCode, type RideState } from "./rides.js";

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

export interface DispatchSelection {
  policy: string;
  selectedCartId: string | null;
  /** Every cart in the fleet, in cart id order. */
  candidates: DispatchCandidate[];
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

/** Select and assign the best cart for one requested ride, or explain why none qualifies. */
export function dispatchRequest(state: RideState, requestId: string): DispatchResult {
  const req = getRequest(state, requestId);
  if (!req.ok) return failWith(req.error);
  const request = req.request;

  const carts = listCarts(state.fleet).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const candidates: DispatchCandidate[] = [];
  const accepted: { candidate: DispatchCandidate; state: RideState; trip: Readonly<Trip> }[] = [];

  for (const cart of carts) {
    const attempt = assignCart(state, requestId, cart.id);
    if (!attempt.ok) {
      if (REQUEST_LEVEL.includes(attempt.error.code)) return failWith(attempt.error);
      candidates.push({ cartId: cart.id, eligible: false, excludedCode: attempt.error.code, excludedReason: attempt.error.message });
      continue;
    }
    // assignCart succeeded, so the cart is at a location and both routes exist.
    if (cart.position.kind !== "at") return failWith({ code: "INCONSISTENT_STATE", message: `${cart.id} was accepted while on a path` });
    const route = shortestRoute(state.graph, cart.position.locationId, request.pickupId);
    if (!route.ok) return failWith({ code: "NO_ROUTE", message: route.error.message });
    const eta = legSecondsLeft(state.graph, cart, { locationIds: route.route.locationIds, pathIds: route.route.pathIds });
    if (!eta.ok) return failWith(eta.error);
    const candidate: DispatchCandidate = { cartId: cart.id, eligible: true, pickupEtaSeconds: eta.seconds, pickupDistanceMeters: route.route.lengthMeters };
    candidates.push(candidate);
    accepted.push({ candidate, state: attempt.state, trip: attempt.trip });
  }

  accepted.sort((a, b) =>
    a.candidate.pickupEtaSeconds! - b.candidate.pickupEtaSeconds! ||
    a.candidate.pickupDistanceMeters! - b.candidate.pickupDistanceMeters! ||
    (a.candidate.cartId < b.candidate.cartId ? -1 : a.candidate.cartId > b.candidate.cartId ? 1 : 0));
  accepted.forEach((a, i) => { a.candidate.rank = i + 1; });

  const best = accepted[0];
  const selection: DispatchSelection = { policy: DISPATCH_POLICY, selectedCartId: best?.candidate.cartId ?? null, candidates };
  if (!best) {
    return { ok: false, error: { code: "NO_CART_AVAILABLE", message: `No cart can take ${requestId} right now; it stays requested`, selection } };
  }
  return { ok: true, state: best.state, trip: best.trip, selection };
}
