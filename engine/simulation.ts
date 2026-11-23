/**
 * Deterministic ride simulation (Phase 1 Part 3). Time only moves when a caller runs `advance`:
 * there are no timers or loops. The same state and the same calls always give the same result.
 *
 * Movement on each path uses the same speed rule as routeEtaSeconds: min(cart speed, path speed),
 * converted from km/h to m/s by dividing by 3.6. A cart only drives the paths of its trip's leg,
 * passes through intermediate locations, and stops exactly at the leg's end (leftover time in that
 * tick is dropped, so it never overshoots a stop). Boarding and drop-off stay explicit operations.
 */
import type { Cart, CartPosition, TripLeg } from "../shared/schemas.js";
import type { CampusGraph } from "./campusGraph.js";
import { getCart } from "./fleet.js";
import { fail, finish, makeTrip, updateFleetCart, whereOnLeg, withChanges, type RideError, type RideResult, type RideState } from "./rides.js";

/** Below this many meters left on a path, the cart counts as having arrived (absorbs floating-point error). */
export const ARRIVAL_EPSILON_METERS = 1e-9;

/**
 * Where the cart ends up after driving `seconds` along `leg` from its current position.
 * Fails (and moves nothing) if the cart is not on the leg or the leg uses a path that cannot be driven.
 */
export function driveLeg(
  graph: CampusGraph,
  cart: Readonly<Cart>,
  leg: TripLeg,
  seconds: number,
): { ok: true; position: CartPosition; reachedEnd: boolean } | { ok: false; error: RideError } {
  const at = whereOnLeg(graph, cart, leg);
  if (!at.ok) return at;
  let edge = at.edge;
  let travelled = at.travelled;
  let budget = seconds;

  while (edge < leg.pathIds.length) {
    const p = graph.paths.get(leg.pathIds[edge]!)!;
    const forward = p.from === leg.locationIds[edge];
    const speed = Math.min(cart.maxSpeedKmh, p.speedKmh) / 3.6; // m/s
    const leftMeters = (1 - travelled) * p.lengthMeters;
    const canDrive = budget * speed;
    if (canDrive + ARRIVAL_EPSILON_METERS >= leftMeters) {
      // Reach the next location and carry the remaining time on.
      budget -= leftMeters / speed;
      edge += 1;
      travelled = 0;
      if (edge === leg.pathIds.length) break; // the leg's end: stop here, drop leftover time
      if (budget <= 0) return { ok: true, position: { kind: "at", locationId: leg.locationIds[edge]! }, reachedEnd: false };
    } else {
      travelled += canDrive / p.lengthMeters;
      return { ok: true, position: { kind: "on_path", pathId: p.id, progress: forward ? travelled : 1 - travelled }, reachedEnd: false };
    }
  }
  return { ok: true, position: { kind: "at", locationId: leg.locationIds.at(-1)! }, reachedEnd: true };
}

/**
 * Advance simulated time by `seconds` for every active or cancelling trip, in trip-id order.
 * - Active trips drive towards their next stop and wait there for `board` or `dropOff`.
 * - Cancelling trips finish their one path; on reaching its end the trip is cancelled and the cart
 *   becomes idle with zero passengers.
 * All or nothing: if any trip cannot move, nothing changes and the error is returned.
 */
export function advance(state: RideState, seconds: number): RideResult {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`Simulation time step must be a positive number of seconds, got ${seconds}`);
  let fleet = state.fleet;
  const changedTrips = [];
  const tripIds = [...state.trips.keys()].sort();

  for (const id of tripIds) {
    const trip = state.trips.get(id)!;
    if (trip.status !== "active" && trip.status !== "cancelling") continue;
    if (!trip.leg) return fail("INCONSISTENT_STATE", `${trip.id} is ${trip.status} without a leg`);
    const found = getCart(fleet, trip.cartId);
    if (!found.ok) return fail("INCONSISTENT_STATE", found.error.message);
    const moved = driveLeg(state.graph, found.cart, trip.leg, seconds);
    if (!moved.ok) return fail(moved.error.code, `${trip.id}: ${moved.error.message}`);

    const cleanupDone = trip.status === "cancelling" && moved.reachedEnd;
    const patch = cleanupDone ? { position: moved.position, status: "idle" } : { position: moved.position };
    const updated = updateFleetCart(fleet, trip.cartId, patch);
    if (!updated.ok) return updated;
    fleet = updated.fleet;
    if (cleanupDone) changedTrips.push(makeTrip({ ...trip, status: "cancelled", leg: null }));
  }

  return finish(withChanges(state, { fleet, trips: changedTrips, clockSeconds: state.clockSeconds + seconds }));
}
