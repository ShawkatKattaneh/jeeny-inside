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
import { drivingSpeedMps, fail, finish, makeTrip, updateFleetCart, whereOnLeg, withChanges, type RideError, type RideResult, type RideState } from "./rides.js";

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
): { ok: true; position: CartPosition; reachedEnd: boolean; secondsDriven: number; edge: number } | { ok: false; error: RideError } {
  const at = whereOnLeg(graph, cart, leg);
  if (!at.ok) return at;
  let edge = at.edge;
  let travelled = at.travelled;
  let budget = seconds;
  // Actual driving time used in this step (Phase 4): the whole step while moving, only the time needed
  // to reach the leg's end when it is reached, and 0 for a cart already standing at the end.
  let driven = 0;

  while (edge < leg.pathIds.length) {
    const p = graph.paths.get(leg.pathIds[edge]!)!;
    const forward = p.from === leg.locationIds[edge];
    const speed = drivingSpeedMps(cart.maxSpeedKmh, p); // m/s, the same rule as legSecondsLeft
    const leftMeters = (1 - travelled) * p.lengthMeters;
    const canDrive = budget * speed;
    if (canDrive + ARRIVAL_EPSILON_METERS >= leftMeters) {
      // Reach the next location and carry the remaining time on.
      const used = Math.min(budget, leftMeters / speed);
      driven += used;
      budget -= leftMeters / speed;
      edge += 1;
      travelled = 0;
      if (edge === leg.pathIds.length) break; // the leg's end: stop here, drop leftover time
      if (budget <= 0) return { ok: true, position: { kind: "at", locationId: leg.locationIds[edge]! }, reachedEnd: false, secondsDriven: driven, edge };
    } else {
      driven += budget;
      travelled += canDrive / p.lengthMeters;
      return { ok: true, position: { kind: "on_path", pathId: p.id, progress: forward ? travelled : 1 - travelled }, reachedEnd: false, secondsDriven: driven, edge };
    }
  }
  return { ok: true, position: { kind: "at", locationId: leg.locationIds.at(-1)! }, reachedEnd: true, secondsDriven: driven, edge: leg.pathIds.length };
}

/**
 * Advance simulated time by `seconds` for every active or cancelling trip, in trip-id order.
 * - Active trips drive towards their next stop and wait there for `board` or `dropOff`.
 * - Cancelling trips finish their one path; on reaching its end the trip is cancelled (or completed,
 *   when it already dropped someone off) and the cart becomes idle with zero passengers.
 * - Each trip's `drivenSeconds` grows by the seconds its cart actually drove in this step.
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
    // drivenSeconds grows only by time actually spent driving; waiting at a stop leaves the trip as it was.
    const drivenSeconds = trip.drivenSeconds + moved.secondsDriven;
    if (cleanupDone) {
      // A trip that already carried someone (a shared trip whose last waiting rider cancelled) ends
      // completed; otherwise, as in Part 3, cancelled.
      const finalStatus = trip.passengers.some((p) => p.droppedOff) ? "completed" : "cancelled";
      changedTrips.push(makeTrip({ ...trip, status: finalStatus, leg: null, drivenSeconds }));
    } else if (moved.secondsDriven > 0) {
      // A re-planned leg can drive the same path twice (finish the current path, then come back along
      // it: Phase 4 joins and cancellations). A position on that path is then ambiguous, so such a leg
      // is trimmed to start at the edge the cart is on. Legs without a repeated path (every Part 3 leg)
      // are left exactly as they were.
      const repeats = new Set(trip.leg.pathIds).size !== trip.leg.pathIds.length;
      const leg = repeats && moved.edge > 0
        ? { locationIds: trip.leg.locationIds.slice(moved.edge), pathIds: trip.leg.pathIds.slice(moved.edge) }
        : trip.leg;
      changedTrips.push(makeTrip({ ...trip, drivenSeconds, leg }));
    }
  }

  return finish(withChanges(state, { fleet, trips: changedTrips, clockSeconds: state.clockSeconds + seconds }));
}
