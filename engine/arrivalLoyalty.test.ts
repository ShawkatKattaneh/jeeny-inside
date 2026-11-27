/**
 * Final completion pass: the driver's explicit arrival confirmation (confirmArrival) and loyalty
 * (after 5 completed paid rides the next ride is free), on the small line campus.
 */
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../shared/settings";
import { assignCart, board, cancel, confirmArrival, createRequest, dropOff, loyaltyProgress, startTrip, type RideState } from "./rides";
import { advance } from "./simulation";
import { cartAt, lineCampus, ok, setup } from "./testRideFixtures";

const campus = lineCampus();

/** One solo ride b -> d for `student` run to completion on CART-01; returns the state and the request. */
function completeRide(s0: RideState, student = "stu-lina") {
  let s = ok(createRequest(s0, { studentId: student, pickupId: "b", destinationId: "d" })).state;
  const id = [...s.requests.keys()].pop()!;
  s = ok(assignCart(s, id, "CART-01")).state;
  s = ok(startTrip(s, id)).state;
  s = ok(advance(s, 600)).state;
  s = ok(board(s, id)).state;
  s = ok(advance(s, 600)).state;
  s = ok(dropOff(s, id)).state;
  return { s, request: s.requests.get(id)! };
}

describe("confirmArrival: the driver's explicit arrival at the current stop", () => {
  function startedTrip() {
    let s = setup(campus, [cartAt("CART-01", "a")]);
    s = ok(createRequest(s, { studentId: "stu-lina", pickupId: "b", destinationId: "d" })).state;
    s = ok(assignCart(s, "REQ-0001", "CART-01")).state;
    return s;
  }

  it("is refused before the trip is driving and while the cart is still on its way", () => {
    const s = startedTrip();
    const tripId = [...s.trips.keys()][0]!;
    expect(confirmArrival(s, tripId)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
    const moving = ok(startTrip(s, "REQ-0001")).state;
    expect(confirmArrival(moving, tripId)).toMatchObject({ ok: false, error: { code: "NOT_AT_STOP" } });
    expect(confirmArrival(moving, "TRIP-9999")).toMatchObject({ ok: false, error: { code: "UNKNOWN_TRIP" } });
  });

  it("at the stop it records the time on that stop only, boards nobody, and cannot be repeated", () => {
    let s = ok(startTrip(startedTrip(), "REQ-0001")).state;
    s = ok(advance(s, 600)).state;
    const tripId = [...s.trips.keys()][0]!;
    const before = s;
    const r = ok(confirmArrival(s, tripId));
    const trip = r.state.trips.get(tripId)!;
    expect(trip.stops[0]!.arrivedAtMs).toBe(Math.round(s.clockSeconds * 1000));
    expect(trip.stops[1]!.arrivedAtMs).toBeUndefined();
    expect(trip.passengers[0]!.boarded).toBe(false);
    expect(r.state.requests.get("REQ-0001")!.status).toBe(before.requests.get("REQ-0001")!.status);
    expect(r.state.fleet.carts.get("CART-01")).toEqual(before.fleet.carts.get("CART-01"));
    expect(confirmArrival(r.state, tripId)).toMatchObject({ ok: false, error: { code: "ALREADY_ARRIVED" } });
    // Boarding stays the driver's own, separate action; the next stop needs its own confirmation.
    let s2 = ok(board(r.state, "REQ-0001")).state;
    expect(confirmArrival(s2, tripId)).toMatchObject({ ok: false, error: { code: "NOT_AT_STOP" } });
    s2 = ok(advance(s2, 600)).state;
    const atDest = ok(confirmArrival(s2, tripId));
    expect(atDest.state.trips.get(tripId)!.stops[1]!.arrivedAtMs).toBeDefined();
    expect(atDest.state.requests.get("REQ-0001")!.status).toBe("on_board");
    s2 = ok(dropOff(atDest.state, "REQ-0001")).state;
    expect(confirmArrival(s2, tripId)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION" } });
  });
});

describe("loyalty: after the approved number of completed paid rides, the next ride is free", () => {
  it(`rides 1 to ${SETTINGS.loyaltyPaidRidesForFree} are paid, the next one is free (fare 0), and counting restarts after it`, () => {
    let s = setup(campus, [cartAt("CART-01", "a")]);
    for (let i = 1; i <= SETTINGS.loyaltyPaidRidesForFree; i++) {
      const r = completeRide(s);
      expect(r.request).toMatchObject({ freeLoyaltyRide: false, fareJod: SETTINGS.fareJod });
      s = r.s;
      expect(loyaltyProgress(s, "stu-lina").paidSinceFree).toBe(i);
    }
    expect(loyaltyProgress(s, "stu-lina").freeRideDue).toBe(true);
    const free = completeRide(s);
    expect(free.request).toMatchObject({ freeLoyaltyRide: true, fareJod: 0, status: "completed" });
    expect(loyaltyProgress(free.s, "stu-lina")).toMatchObject({ paidSinceFree: 0, freeRideDue: false });
    const next = completeRide(free.s);
    expect(next.request).toMatchObject({ freeLoyaltyRide: false, fareJod: SETTINGS.fareJod });
  });

  it("cancelled rides never count, a cancelled free ride stays due, and other students are counted separately", () => {
    let s = setup(campus, [cartAt("CART-01", "a")]);
    for (let i = 0; i < SETTINGS.loyaltyPaidRidesForFree - 1; i++) s = completeRide(s).s;
    s = ok(createRequest(s, { studentId: "stu-lina", pickupId: "b", destinationId: "d" })).state;
    s = ok(cancel(s, [...s.requests.keys()].pop()!)).state;
    expect(loyaltyProgress(s, "stu-lina").freeRideDue).toBe(false);
    s = completeRide(s).s;
    s = ok(createRequest(s, { studentId: "stu-lina", pickupId: "b", destinationId: "d" })).state;
    const freeId = [...s.requests.keys()].pop()!;
    expect(s.requests.get(freeId)).toMatchObject({ freeLoyaltyRide: true, fareJod: 0 });
    s = ok(cancel(s, freeId)).state;
    s = ok(createRequest(s, { studentId: "stu-lina", pickupId: "b", destinationId: "d" })).state;
    expect(s.requests.get([...s.requests.keys()].pop()!)).toMatchObject({ freeLoyaltyRide: true, fareJod: 0 });
    s = ok(createRequest(s, { studentId: "stu-omar", pickupId: "b", destinationId: "d" })).state;
    expect(s.requests.get([...s.requests.keys()].pop()!)).toMatchObject({ freeLoyaltyRide: false, fareJod: SETTINGS.fareJod });
  });
});
