/**
 * Phase 5 Prompt 2: campus analytics as a pure function of real engine states, built with the real ride
 * operations (no hand-made metrics). Line campus: a - b - c - d - e, 10 s per path for these carts.
 */
import { describe, expect, it } from "vitest";
import { AnalyticsResponse } from "../shared/analytics";
import { RideRequest } from "../shared/schemas";
import { computeAnalytics, durationStats } from "./analytics";
import { dispatchRequest } from "./dispatch";
import { board, cancel, createRequest, dropOff, startTrip, withChanges, type RideState } from "./rides";
import { advance } from "./simulation";
import { tapIn } from "./tapIn";
import { cartAt, lineCampus, ok, setup } from "./testRideFixtures";

const campus = lineCampus();
const twoCarts = () => setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
const analytics = (s: RideState, revision = 0) => AnalyticsResponse.parse(computeAnalytics(s, revision));

function req(s: RideState, studentId: string, pickupId: string, destinationId: string, mode: "solo" | "shared" = "solo") {
  const r = ok(createRequest(s, { studentId, pickupId, destinationId, mode }));
  return { s: r.state, id: r.request.id };
}
function dispatch(s: RideState, id: string): RideState {
  const r = dispatchRequest(s, id);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}
const tap = (s: RideState, id: string, studentId: string, pointId: string) => ok(tapIn(s, id, { studentId, campusId: "line", pointId })).state;

/** Lina b->d and Omar c->e share CART-01 (Omar joins); Lina taps in at 10 s and boards at 15 s. */
function ghostRide() {
  let s = twoCarts();
  let lina: string, omar: string;
  ({ s, id: lina } = req(s, "stu-lina", "b", "d", "shared"));
  s = dispatch(s, lina);
  ({ s, id: omar } = req(s, "stu-omar", "c", "e", "shared"));
  s = dispatch(s, omar);
  s = ok(startTrip(s, lina)).state;
  s = ok(advance(s, 10)).state; // CART-01 reaches b
  s = tap(s, lina, "stu-lina", "b"); // Tap-In at 10 s
  s = ok(advance(s, 5)).state; // waits at b: the clock moves, the cart does not
  s = ok(board(s, lina)).state; // boarding at 15 s (not recorded as its own timestamp)
  return { s, lina, omar };
}

describe("empty state", () => {
  it("every count is zero, every duration has no measurement, and nothing is observed", () => {
    const a = analytics(twoCarts());
    expect(a.demand).toMatchObject({ totalRequests: 0, activeRequests: 0, finishedRequests: 0, totalTrips: 0, tripsWithTwoOrMoreRiders: 0, totalRiders: 0 });
    expect(a.locations).toEqual({ pickups: [], destinations: [] });
    for (const d of [a.waiting.requestToTapIn, a.waiting.currentElapsedWait, a.waiting.requestToDropOff]) {
      expect(d).toEqual({ status: "available", measuredRequests: 0, meanSeconds: null, medianSeconds: null, maxSeconds: null });
    }
    expect(a.cancellations.shareOfFinished).toBeNull();
    expect(a.observations).toEqual([]);
    expect(a.fleet.perCart.map((c) => c.totalTrips)).toEqual([0, 0]);
  });
});

describe("counting units stay separate", () => {
  it("a Ghost Ride with two riders is 2 ride requests, 1 trip and 2 rider entries", () => {
    const { s } = ghostRide();
    const a = analytics(s);
    expect(a.demand.totalRequests).toBe(2);
    expect(a.demand.totalTrips).toBe(1);
    expect(a.demand.tripsWithTwoOrMoreRiders).toBe(1);
    expect(a.demand.totalRiders).toBe(2);
    expect(a.demand.requestsByMode).toEqual({ solo: 0, shared: 2 });
    expect(a.demand.requestsByStatus).toEqual({ requested: 0, assigned: 0, arriving: 1, on_board: 1, completed: 0, cancelled: 0 });
    expect(a.demand.tripsByStatus).toEqual({ planned: 0, active: 1, cancelling: 0, completed: 0, cancelled: 0 });
    expect(a.demand.activeRequests).toBe(2);
  });

  it("pickups and destinations are separate counts of ride requests, highest first, with campus names", () => {
    let s = twoCarts();
    ({ s } = req(s, "stu-lina", "b", "d"));
    ({ s } = req(s, "stu-omar", "b", "e"));
    ({ s } = req(s, "stu-sara", "c", "d"));
    const a = analytics(s);
    expect(a.locations.pickups.map((p) => [p.locationId, p.name, p.totalRequests])).toEqual([["b", "b", 2], ["c", "c", 1]]);
    expect(a.locations.destinations.map((p) => [p.locationId, p.totalRequests])).toEqual([["d", 2], ["e", 1]]);
    expect(a.locations.pickups.every((p) => p.knownLocation)).toBe(true);
  });

  it("a location id that is not on the campus is listed as unknown, never invented or dropped", () => {
    let s = twoCarts();
    ({ s } = req(s, "stu-lina", "b", "d"));
    // Bypasses the engine checks on purpose: only to prove the analytics handle a bad reference safely.
    const odd = Object.freeze(RideRequest.parse({ ...s.requests.get("REQ-0001")!, id: "REQ-0002", pickupId: "old-gate" }));
    s = withChanges(s, { requests: [odd], nextRequestNo: 3 });
    const a = analytics(s);
    expect(a.locations.pickups).toContainEqual(expect.objectContaining({ locationId: "old-gate", name: null, knownLocation: false, totalRequests: 1 }));
    expect(a.observations[0]!.text).toContain("old-gate (not on this campus)");
  });
});

describe("waiting times", () => {
  it("request-to-Tap-In uses the Tap-In time, never the boarding time, and boarding is unavailable", () => {
    const { s } = ghostRide();
    const a = analytics(s);
    expect(a.waiting.requestToTapIn).toEqual({ status: "available", measuredRequests: 1, meanSeconds: 10, medianSeconds: 10, maxSeconds: 10 });
    expect(a.waiting.requestToBoarding.status).toBe("unavailable");
    expect(a.waiting.requestToBoarding.reason).toMatch(/Boarding time is not saved/);
  });

  it("a rider who boards without tapping in is not measured (no fabricated Tap-In value)", () => {
    let s = twoCarts();
    let id: string;
    ({ s, id } = req(s, "stu-lina", "b", "d"));
    s = dispatch(s, id);
    s = ok(startTrip(s, id)).state;
    s = ok(advance(s, 10)).state;
    s = ok(board(s, id)).state;
    expect(analytics(s).waiting.requestToTapIn.measuredRequests).toBe(0);
    expect(analytics(s).waiting.requestToTapIn.meanSeconds).toBeNull();
  });

  it("current elapsed wait covers only requests still waiting, and is kept apart from finished durations", () => {
    const { s: base, lina } = ghostRide();
    let s = base;
    let sara: string;
    ({ s, id: sara } = req(s, "stu-sara", "a", "c")); // created at 15 s, never dispatched
    s = ok(advance(s, 20)).state; // now 35 s; CART-01 drives on to c (Omar's pickup) and waits there
    s = ok(board(s, s.requests.get("REQ-0002")!.id)).state;
    s = ok(advance(s, 10)).state; // now 45 s, at d
    s = ok(dropOff(s, lina)).state; // Lina completes at 45 s
    const a = analytics(s);
    // Waiting now: only Sara (requested). Omar is on board, Lina completed.
    expect(a.waiting.currentElapsedWait).toEqual({ status: "available", measuredRequests: 1, meanSeconds: 30, medianSeconds: 30, maxSeconds: 30 });
    // Completed: Lina, created at 0 s, completed at 45 s.
    expect(a.waiting.requestToDropOff).toEqual({ status: "available", measuredRequests: 1, meanSeconds: 45, medianSeconds: 45, maxSeconds: 45 });
    const byA = a.waiting.byPickup.find((p) => p.locationId === "a")!;
    expect(byA.currentElapsedWait.maxSeconds).toBe(30);
    expect(byA.requestToTapIn.measuredRequests).toBe(0);
    expect(a.observations.map((o) => o.text)).toContain("Longest current elapsed wait: 30 simulated seconds, at a.");
    expect(sara).toBe("REQ-0003");
  });

  it("median, mean and max follow their definitions; invalid durations are not measured", () => {
    expect(durationStats([1000, 3000, 2000, 10000])).toEqual({ status: "available", measuredRequests: 4, meanSeconds: 4, medianSeconds: 2.5, maxSeconds: 10 });
    expect(durationStats([5000, -1, Number.NaN, Infinity])).toEqual({ status: "available", measuredRequests: 1, meanSeconds: 5, medianSeconds: 5, maxSeconds: 5 });
  });
});

describe("fleet", () => {
  it("every cart status is counted on its own; charging, offline and maintenance are out of service, never available", () => {
    const s = setup(campus, [
      cartAt("CART-01", "a"),
      cartAt("CART-02", "b", { status: "charging" }),
      cartAt("CART-03", "c", { status: "offline" }),
      cartAt("CART-04", "d", { status: "maintenance" }),
    ]);
    const a = analytics(s);
    expect(a.fleet.cartsByStatus).toEqual({ idle: 1, assigned: 0, occupied: 0, charging: 1, offline: 1, maintenance: 1 });
    expect(a.fleet.outOfServiceCarts).toBe(3);
    expect(a.fleet.totalCarts).toBe(4);
  });

  it("dispatch eligibility is unavailable, even when idle carts exist (no simplified count)", () => {
    const a = analytics(twoCarts());
    expect(a.fleet.cartsByStatus.idle).toBe(2);
    expect(a.fleet.dispatchEligibleCarts).toEqual({ status: "unavailable", reason: expect.stringMatching(/depends on the specific request/) });
    expect(a.fleet.utilizationOverTime.status).toBe("unavailable");
  });

  it("seat occupancy is passengers on board divided by the seats of every cart", () => {
    const { s } = ghostRide(); // Lina on board CART-01; 2 carts x 4 seats
    expect(analytics(s).fleet.seatOccupancy).toEqual({ status: "available", onBoardPassengers: 1, totalSeats: 8, ratio: 1 / 8 });
  });

  it("trips per cart come from each trip's own cart, including finished trips", () => {
    let s = twoCarts();
    let a1: string, a2: string;
    ({ s, id: a1 } = req(s, "stu-lina", "b", "c"));
    s = dispatch(s, a1); // CART-01
    s = ok(cancel(s, a1)).state; // planned trip cancelled: CART-01 free again
    ({ s, id: a2 } = req(s, "stu-omar", "d", "e"));
    s = dispatch(s, a2); // CART-02 is nearer d
    s = ok(startTrip(s, a2)).state;
    s = ok(advance(s, 10)).state;
    s = ok(board(s, a2)).state;
    s = ok(advance(s, 10)).state;
    s = ok(dropOff(s, a2)).state;
    const a = analytics(s);
    expect(a.fleet.perCart).toEqual([
      { cartId: "CART-01", label: "CART-01", totalTrips: 1, completedTrips: 0, cancelledTrips: 1, openTrips: 0, droppedOffRiders: 0 },
      { cartId: "CART-02", label: "CART-02", totalTrips: 1, completedTrips: 1, cancelledTrips: 0, openTrips: 0, droppedOffRiders: 1 },
    ]);
    expect(a.cancellations).toMatchObject({ cancelledRequests: 1, finishedRequests: 2, shareOfFinished: 0.5 });
    expect(a.cancellations.cancelledAtStage.status).toBe("unavailable");
  });
});

describe("coverage and time", () => {
  it("history starts at simulated second 0; calendar windows and demand over time are unavailable, never zero", () => {
    const { s } = ghostRide();
    const a = analytics(s, 7);
    expect(a.revision).toBe(7);
    expect(a.clock).toEqual({ basis: "simulated", nowSeconds: 15 });
    expect(a.coverage.historyStartsAtSimulatedSeconds).toBe(0);
    expect(a.coverage.note).toMatch(/complete for this database/);
    expect(a.coverage.calendarWindows).toEqual({ status: "unavailable", reason: expect.stringMatching(/only simulated-clock times/) });
    expect(a.coverage.demandOverTime.status).toBe("unavailable");
  });

  it("contains no student ids", () => {
    const { s } = ghostRide();
    expect(JSON.stringify(computeAnalytics(s, 0))).not.toMatch(/stu-/);
  });

  it("observations are factual statements with their metric, population and window; no bottleneck claims", () => {
    const { s } = ghostRide();
    const a = analytics(s);
    expect(a.observations.length).toBeGreaterThan(0);
    for (const o of a.observations) {
      expect(o.metric && o.population && o.window).toBeTruthy();
      expect(o.text.toLowerCase()).not.toMatch(/bottleneck|problem|overload/);
    }
    expect(a.observations[0]!.text).toBe("Highest observed pickup volume: b, c with 1 of 2 ride requests each.");
  });
});

describe("a finished rider on a shared trip that carries on (Phase 5 Prompt 3)", () => {
  // requestToDropOff reads a completed request's updatedAt as its completion time. That only holds if
  // later operations on the SAME shared trip never touch the completed request. Real engine operations
  // only: board, advance (the simulation), dropOff.
  it("Passenger A keeps its completion time and rider entry while B advances and is dropped off", () => {
    const { s: base, lina, omar } = ghostRide();
    let s = ok(advance(base, 10)).state; // 25 s: CART-01 at c, Omar's pickup
    s = ok(board(s, omar)).state;
    s = ok(advance(s, 10)).state; // 35 s: at d, Lina's stop
    s = ok(dropOff(s, lina)).state; // A completes at 35 s
    const tripOf = (st: RideState) => [...st.trips.values()].find((t) => t.passengers.some((p) => p.requestId === lina))!;
    const aRequest = s.requests.get(lina)!;
    const aRider = tripOf(s).passengers.find((p) => p.requestId === lina)!;
    expect(aRequest).toMatchObject({ status: "completed", updatedAt: 35_000 });
    expect(s.requests.get(omar)!.status).toBe("on_board");
    const aRequestCopy = structuredClone(aRequest);
    const aRiderCopy = structuredClone(aRider);
    const aDropOff = analytics(s).waiting.requestToDropOff;
    expect(aDropOff).toMatchObject({ measuredRequests: 1, maxSeconds: 35 });

    // Transition 1: the simulation moves the shared cart on with B aboard.
    const beforeAdvance = s;
    s = ok(advance(s, 10)).state; // 45 s: at e, Omar's stop
    expect(s.clockSeconds).toBe(45);
    expect(s).not.toBe(beforeAdvance);
    expect(s.requests.get(lina)).toEqual(aRequestCopy);
    expect(tripOf(s).passengers.find((p) => p.requestId === lina)).toEqual(aRiderCopy);
    expect(tripOf(s).status).toBe("active");

    // Transition 2: B is dropped off; the trip ends.
    const omarBefore = s.requests.get(omar)!;
    const r = dropOff(s, omar);
    expect(r.ok).toBe(true);
    s = ok(r).state;
    expect(omarBefore.status).toBe("on_board");
    expect(s.requests.get(omar)).toMatchObject({ status: "completed", updatedAt: 45_000 });
    expect(tripOf(s).passengers.find((p) => p.requestId === omar)).toMatchObject({ boarded: true, droppedOff: true });
    expect(tripOf(s).status).toBe("completed");
    // A is untouched by both: same request (status, updatedAt, fare, ids, every field) and same rider entry.
    expect(s.requests.get(lina)).toEqual(aRequestCopy);
    expect(s.requests.get(lina)!.updatedAt).toBe(35_000);
    expect(tripOf(s).passengers.find((p) => p.requestId === lina)).toEqual(aRiderCopy);
    // A finished request cannot be moved again.
    expect(dropOff(s, lina)).toMatchObject({ ok: false, error: { code: "RIDE_FINISHED" } });

    // The analytics derived from it: A stays at 35 s, B adds 45 s (created at 0 s, completed at 45 s).
    const a = analytics(s);
    expect(a.waiting.requestToDropOff).toEqual({ status: "available", measuredRequests: 2, meanSeconds: 40, medianSeconds: 40, maxSeconds: 45 });
    expect(a.demand).toMatchObject({ totalTrips: 1, tripsWithTwoOrMoreRiders: 1, totalRiders: 2, droppedOffRiders: 2 });
  });
});

describe("metric correctness rechecks (Phase 5 Prompt 3)", () => {
  it("cancelled riders count every cancelled rider entry: one cancelled alone with its trip, one cancelled from a shared trip", () => {
    let s = twoCarts();
    let sara: string, lina: string, omar: string;
    ({ s, id: sara } = req(s, "stu-sara", "a", "c")); // solo, alone on CART-01's trip
    s = dispatch(s, sara);
    s = ok(cancel(s, sara)).state; // the trip is cancelled with her; her rider entry carries no per-rider flag
    ({ s, id: lina } = req(s, "stu-lina", "b", "d", "shared"));
    s = dispatch(s, lina);
    ({ s, id: omar } = req(s, "stu-omar", "c", "e", "shared"));
    s = dispatch(s, omar); // joins Lina's trip
    s = ok(cancel(s, omar)).state; // the shared trip carries on for Lina; Omar's entry is flagged
    const saraTrip = [...s.trips.values()].find((t) => t.passengers.some((p) => p.requestId === sara))!;
    expect(saraTrip.status).toBe("cancelled");
    expect(saraTrip.passengers.find((p) => p.requestId === sara)!.cancelled).toBe(false);
    const sharedTrip = [...s.trips.values()].find((t) => t.passengers.some((p) => p.requestId === lina))!;
    expect(sharedTrip.passengers.length).toBe(2);
    expect(sharedTrip.status).not.toBe("cancelled");
    const a = analytics(s);
    expect(a.demand).toMatchObject({ totalRiders: 3, cancelledRiders: 2, droppedOffRiders: 0, tripsWithTwoOrMoreRiders: 1 });
    expect(a.demand.cancelledRiders).toBe(a.demand.requestsByStatus.cancelled); // here every request was on a trip
  });

  it("'now' uses the engine's timestamp rule, so a request created at a fractional clock is measured, not dropped", () => {
    let s = ok(advance(twoCarts(), 0.0006)).state; // engine time rounds to 1 ms
    let id: string;
    ({ s, id } = req(s, "stu-lina", "a", "b"));
    expect(s.requests.get(id)!.createdAt).toBe(1);
    expect(analytics(s).waiting.currentElapsedWait).toEqual({ status: "available", measuredRequests: 1, meanSeconds: 0, medianSeconds: 0, maxSeconds: 0 });
  });
});
