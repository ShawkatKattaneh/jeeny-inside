/**
 * Phase 4 Tap-In: a rider checks in at their assigned pickup point (NFC tag or QR code, both opening
 * the same /tap URL). It is an arrival record only:
 * - it writes the write-once `tappedIn { locationId, atMs }` on the rider's trip passenger, and nothing else;
 * - it never boards anyone, never changes a request, a cart, the stops or the trip status;
 * - it proves nothing about presence or identity (public URLs, demo personas, no auth).
 *
 * Approved check order (the first match wins; a refusal or a replay leaves the state untouched):
 *   2. the request exists                                    UNKNOWN_REQUEST (404)
 *   3. the campus is this campus and the point is a location UNKNOWN_POINT (400)
 *   4. the point is a stop (canStop)                          POINT_NOT_SUPPORTED (400)
 *   5. studentId matches the request                          NOT_YOUR_RIDE (409)
 *   6. an existing record: same point -> replay (the original record, alreadyRecorded, SAME state object);
 *                          other point -> PICKUP_MISMATCH (409). Both in any lifecycle state.
 *   7. first Tap-In only: request assigned/arriving, rider waiting  TAP_IN_NOT_ALLOWED (409)
 *   8. first Tap-In only: point === request.pickupId          PICKUP_MISMATCH (409)
 *   9. write the record (one committed state -> one ride.tapped_in revision in the store).
 * Step 1 (the strict body) is the server's job (shared/schemas.ts TapInBody).
 *
 * Returning the same state object on a replay is what makes the store skip the revision and the
 * broadcast (server/state.ts). The store runs each operation synchronously, so two simultaneous
 * calls are applied one after the other and only the first can write.
 */
import type { RideRequest, Trip } from "../shared/schemas.js";
import { fail, finish, getRequest, makeTrip, nowMs, tripForRequest, withChanges, type RideResult, type RideState } from "./rides.js";

export interface TapInInput {
  studentId: string;
  campusId: string;
  pointId: string;
}

/** The record as the API returns it. */
export interface TapInRecord {
  requestId: string;
  locationId: string;
  atMs: number;
}

export type TapInResult = RideResult<{ trip: Readonly<Trip>; tapIn: TapInRecord; alreadyRecorded: boolean }>;

const OPEN_FOR_TAP_IN: readonly RideRequest["status"][] = ["assigned", "arriving"];

export function tapIn(state: RideState, requestId: string, input: TapInInput): TapInResult {
  // 2. Request.
  const req = getRequest(state, requestId);
  if (!req.ok) return req;
  const request = req.request;

  // 3. Campus and point.
  if (input.campusId !== state.campus.id) return fail("UNKNOWN_POINT", `Tap point campus "${input.campusId}" is not this campus ("${state.campus.id}")`);
  const point = state.campus.locations.find((l) => l.id === input.pointId);
  if (!point) return fail("UNKNOWN_POINT", `"${input.pointId}" is not a point on ${state.campus.name}`);

  // 4. Point support.
  if (!point.canStop) return fail("POINT_NOT_SUPPORTED", `${point.name} is not a stop, so it cannot be a pickup point`);

  // 5. Student consistency (demo persona; not authentication).
  if (input.studentId !== request.studentId) return fail("NOT_YOUR_RIDE", `${requestId} belongs to another student`);

  const trip = tripForRequest(state, requestId);
  const passenger = trip?.passengers.find((p) => p.requestId === requestId);

  // 6. Existing record: replay or mismatch, whatever the rider's state is now.
  if (trip && passenger?.tappedIn) {
    const recorded = passenger.tappedIn;
    if (recorded.locationId === point.id) {
      return { ok: true, state, trip, tapIn: { requestId, locationId: recorded.locationId, atMs: recorded.atMs }, alreadyRecorded: true };
    }
    return fail("PICKUP_MISMATCH", `${requestId} already tapped in at "${recorded.locationId}", not "${point.id}"`);
  }

  // 7. First Tap-In: the ride must be dispatched and the rider still waiting for pickup.
  const reason = ineligibility(request, trip, passenger);
  if (reason) return fail("TAP_IN_NOT_ALLOWED", `${requestId} cannot tap in: ${reason}`);

  // 8. First Tap-In: exactly the assigned pickup.
  if (point.id !== request.pickupId) return fail("PICKUP_MISMATCH", `${point.name} is not the pickup for ${requestId} (its pickup is "${request.pickupId}")`);

  // 9. Write once. Only this passenger's tappedIn changes.
  const record = { locationId: point.id, atMs: nowMs(state) };
  const next = makeTrip({ ...trip!, passengers: trip!.passengers.map((p) => (p.requestId === requestId ? { ...p, tappedIn: record } : p)) });
  return finish(withChanges(state, { trips: [next] }), { trip: next, tapIn: { requestId, ...record }, alreadyRecorded: false });
}

function ineligibility(request: Readonly<RideRequest>, trip: Readonly<Trip> | undefined, passenger: Trip["passengers"][number] | undefined): string | null {
  if (request.status === "requested") return "it has not been dispatched to a cart yet";
  if (request.status === "on_board") return "the rider is already on board";
  if (request.status === "completed") return "the ride is finished";
  if (request.status === "cancelled") return "the ride is cancelled";
  if (!OPEN_FOR_TAP_IN.includes(request.status) || !trip || !passenger) return "it has no trip waiting at the pickup";
  if (passenger.boarded) return "the rider is already on board";
  if (passenger.droppedOff) return "the rider was already dropped off";
  if (passenger.cancelled) return "the ride is cancelled";
  return null;
}
