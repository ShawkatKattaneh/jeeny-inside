/**
 * Ghost Ride join operation (Phase 4). One atomic engine operation: a requested SHARED ride joins one
 * open trip, using the stop sequence chosen by `evaluateJoin` (engine/sharedPlan.ts). Either the new
 * state passes every ride invariant, or an error is returned and the caller keeps its old state.
 *
 * What changes on success, and nothing else:
 * - the joining request: requested -> assigned (planned trip) or arriving (moving trip, Stage 3);
 * - the trip: the new stops inserted (existing order kept), the rider appended to `passengers` with its
 *   write-once original baseline, and for a moving trip the leg re-planned only when the new pickup
 *   becomes the next stop (a mid-path cart first finishes the path it is on).
 * The cart is not changed (still assigned: nobody has boarded in Stages 2 and 3), and the other riders'
 * requests, baselines and statuses are not touched.
 */
import type { RideRequest, Trip } from "../shared/schemas.js";
import { fail, finish, getRequest, makeTrip, withChanges, type RideResult, type RideState } from "./rides.js";
import { evaluateJoin, type JoinPlan, type SoloBaselineInput } from "./sharedPlan.js";

export function joinTrip(state: RideState, requestId: string, tripId: string, joinerSolo: SoloBaselineInput | null): RideResult<{ trip: Readonly<Trip>; plan: JoinPlan }> {
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;
  if (request.status !== "requested") return fail(request.status === "completed" || request.status === "cancelled" ? "RIDE_FINISHED" : "INVALID_TRANSITION", `${requestId} is ${request.status}; only a requested ride can join a trip`);
  if (request.mode !== "shared") return fail("REQUEST_NOT_SHARED", `${requestId} is a solo ride; only a shared ride can join another trip`);

  const ev = evaluateJoin(state, tripId, request, joinerSolo);
  if (!ev.ok) return fail(ev.code, ev.reason);
  const plan = ev.plan;
  const trip = state.trips.get(tripId)!;

  const joined = makeTrip({
    ...trip,
    stops: plan.stops,
    passengers: [...trip.passengers, { requestId, boarded: false, droppedOff: false, cancelled: false, baseline: plan.joinerBaseline }],
    leg: plan.leg,
  });
  const t = Math.round(state.clockSeconds * 1000);
  const updated: Readonly<RideRequest> = Object.freeze({ ...request, status: trip.status === "planned" ? "assigned" : "arriving", updatedAt: t });
  return finish(withChanges(state, { requests: [updated], trips: [joined] }), { trip: joined, plan });
}
