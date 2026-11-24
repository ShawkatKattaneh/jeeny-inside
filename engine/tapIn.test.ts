/**
 * Phase 4 Tap-In engine (engine/tapIn.ts): the approved check order, write-once history, exact-replay
 * idempotency in every lifecycle state, and that a Tap-In changes nothing but the rider's record.
 *
 * Line campus (testRideFixtures.ts): a - b - c - d - e, 10 s per path for the cart; "x" exists but is
 * not a stop. Lina rides b -> d on CART-01, which starts at a.
 */
import { describe, expect, it } from "vitest";
import * as R from "./rides";
import { advance } from "./simulation";
import { dispatchRequest } from "./dispatch";
import { tapIn, type TapInInput } from "./tapIn";
import { cartAt, lineCampus, ok, setup, snapshot } from "./testRideFixtures";

type S = R.RideState;
const line = lineCampus();
const LINA = "stu-lina";
const at = (pointId: string, over: Partial<TapInInput> = {}): TapInInput => ({ studentId: LINA, campusId: "line", pointId, ...over });

function booked(mode: "solo" | "shared" = "solo") {
  let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
  const r = ok(R.createRequest(s, { studentId: LINA, pickupId: "b", destinationId: "d", mode }));
  s = r.state;
  return { s, id: r.request.id };
}
const dispatched = () => {
  const { s, id } = booked();
  const d = dispatchRequest(s, id);
  if (!d.ok) throw new Error(d.error.message);
  return { s: d.state, id };
};
const started = () => {
  const { s, id } = dispatched();
  return { s: ok(R.startTrip(s, id)).state, id };
};
/** The cart has reached b (the pickup): the driver could board now. */
const atPickup = () => {
  const { s, id } = started();
  return { s: ok(advance(s, 10)).state, id };
};
const boarded = (s: S, id: string) => ok(R.board(s, id)).state;
const droppedOff = (s: S, id: string) => ok(R.dropOff(ok(advance(s, 20)).state, id)).state;
const passenger = (s: S, id: string) => R.tripForRequest(s, id)!.passengers.find((p) => p.requestId === id)!;
const code = (r: ReturnType<typeof tapIn>) => (r.ok ? "OK" : r.error.code);
const first = (s: S, id: string, pointId = "b") => {
  const r = tapIn(s, id, at(pointId));
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
};

describe("Tap-In: first successful check-in", () => {
  it("records a write-once {locationId, atMs} on the rider, at server time, and reports alreadyRecorded false", () => {
    const { s, id } = dispatched();
    const s2 = ok(advance(ok(R.startTrip(s, id)).state, 7)).state; // clock 7 s, cart on its way
    const r = first(s2, id);
    expect(r.alreadyRecorded).toBe(false);
    expect(r.tapIn).toEqual({ requestId: id, locationId: "b", atMs: 7000 });
    expect(passenger(r.state, id).tappedIn).toEqual({ locationId: "b", atMs: 7000 });
    expect(r.state).not.toBe(s2);
    expect(R.checkRideInvariants(r.state)).toEqual([]);
  });

  it("is allowed while the ride is assigned (planned trip) and while arriving (active trip)", () => {
    expect(code(tapIn(dispatched().s, dispatched().id, at("b")))).toBe("OK");
    const a = started();
    expect(a.s.requests.get(a.id)!.status).toBe("arriving");
    expect(code(tapIn(a.s, a.id, at("b")))).toBe("OK");
  });

  it("changes only that rider's tappedIn: request, fare, loyalty, cart, stops, flags, status, clock and counters stay the same", () => {
    const { s, id } = atPickup();
    const r = first(s, id);
    const before = JSON.parse(snapshot(s));
    const after = JSON.parse(snapshot(r.state));
    // Remove the one approved change and the rest must be identical.
    delete after.trips[0].passengers[0].tappedIn;
    expect(after).toEqual(before);
    expect(r.state.requests).toBe(s.requests); // the request map (fare, loyalty, status, dispatch) is untouched
    expect(r.state.fleet).toBe(s.fleet); // carts, passenger counts and positions are untouched
    const p = passenger(r.state, id);
    expect([p.boarded, p.droppedOff, p.cancelled]).toEqual([false, false, false]);
    expect(r.state.fleet.carts.get("CART-01")!.passengerCount).toBe(0);
  });

  it("never boards: the driver's board call is still required and still works after a Tap-In", () => {
    const { s, id } = atPickup();
    const t = first(s, id).state;
    expect(t.requests.get(id)!.status).toBe("arriving");
    const b = boarded(t, id);
    expect(b.requests.get(id)!.status).toBe("on_board");
    expect(passenger(b, id).tappedIn).toEqual({ locationId: "b", atMs: 10000 }); // history kept through boarding
  });
});

describe("Tap-In: refusals in the approved order (each leaves the state untouched)", () => {
  const refuses = (s: S, id: string, input: TapInInput, expected: string) => {
    const before = snapshot(s);
    const r = tapIn(s, id, input);
    expect(code(r)).toBe(expected);
    expect(snapshot(s)).toBe(before);
  };

  it("unknown request -> UNKNOWN_REQUEST", () => refuses(dispatched().s, "REQ-9999", at("b"), "UNKNOWN_REQUEST"));
  it("campus mismatch or unknown campus -> UNKNOWN_POINT", () => {
    const { s, id } = dispatched();
    refuses(s, id, at("b", { campusId: "wadi-cedar" }), "UNKNOWN_POINT");
    refuses(s, id, at("b", { campusId: "no-such-campus" }), "UNKNOWN_POINT");
  });
  it("unknown point -> UNKNOWN_POINT", () => refuses(dispatched().s, dispatched().id, at("zz"), "UNKNOWN_POINT"));
  it("a location that is not a stop -> POINT_NOT_SUPPORTED", () => refuses(dispatched().s, dispatched().id, at("x"), "POINT_NOT_SUPPORTED"));
  it("another student's ride -> NOT_YOUR_RIDE", () => refuses(dispatched().s, dispatched().id, at("b", { studentId: "stu-omar" }), "NOT_YOUR_RIDE"));
  it("not dispatched yet (requested) -> TAP_IN_NOT_ALLOWED", () => refuses(booked().s, booked().id, at("b"), "TAP_IN_NOT_ALLOWED"));
  it("a supported stop that is not the assigned pickup -> PICKUP_MISMATCH", () => refuses(dispatched().s, dispatched().id, at("c"), "PICKUP_MISMATCH"));

  it("first Tap-In after boarding, after drop-off and after cancellation -> TAP_IN_NOT_ALLOWED", () => {
    const { s, id } = atPickup();
    const b = boarded(s, id);
    refuses(b, id, at("b"), "TAP_IN_NOT_ALLOWED");
    refuses(droppedOff(b, id), id, at("b"), "TAP_IN_NOT_ALLOWED");
    const c = dispatched();
    refuses(ok(R.cancel(c.s, c.id)).state, c.id, at("b"), "TAP_IN_NOT_ALLOWED");
  });

  it("checks run in the approved order: campus/point before student, student before lifecycle, lifecycle before pickup", () => {
    const req = booked(); // requested: lifecycle would refuse
    expect(code(tapIn(req.s, req.id, at("x", { studentId: "stu-omar" })))).toBe("POINT_NOT_SUPPORTED");
    expect(code(tapIn(req.s, req.id, at("zz", { studentId: "stu-omar" })))).toBe("UNKNOWN_POINT");
    expect(code(tapIn(req.s, req.id, at("c", { studentId: "stu-omar" })))).toBe("NOT_YOUR_RIDE");
    expect(code(tapIn(req.s, req.id, at("c")))).toBe("TAP_IN_NOT_ALLOWED"); // not PICKUP_MISMATCH: lifecycle first when no record
  });
});

describe("Tap-In: idempotency and history", () => {
  it("an exact replay returns the original record and timestamp, alreadyRecorded true, and the SAME state object", () => {
    const { s, id } = started();
    const one = first(ok(advance(s, 3)).state, id);
    const later = ok(advance(one.state, 4)).state; // time moves on
    const two = tapIn(later, id, at("b"));
    expect(two.ok && two.alreadyRecorded).toBe(true);
    expect(two.ok && two.tapIn).toEqual({ requestId: id, locationId: "b", atMs: 3000 });
    expect(two.ok && two.state).toBe(later); // nothing new to commit: no revision in the store
  });

  it("exact replay still succeeds after boarding, after drop-off and after cancellation, with the original record", () => {
    const { s, id } = atPickup();
    const t = first(s, id).state;
    const b = boarded(t, id);
    const d = droppedOff(b, id);
    for (const state of [b, d]) {
      const r = tapIn(state, id, at("b"));
      expect(r.ok && [r.alreadyRecorded, r.tapIn.atMs, r.state === state]).toEqual([true, 10000, true]);
    }
    const c = dispatched();
    const tapped = first(c.s, c.id).state;
    const cancelled = ok(R.cancel(tapped, c.id)).state;
    expect(cancelled.requests.get(c.id)!.status).toBe("cancelled");
    const r = tapIn(cancelled, c.id, at("b"));
    expect(r.ok && [r.alreadyRecorded, r.tapIn.locationId, r.state === cancelled]).toEqual([true, "b", true]);
  });

  it("a different point when a record exists -> PICKUP_MISMATCH, also after boarding, drop-off and cancellation; the record stays", () => {
    const { s, id } = atPickup();
    const t = first(s, id).state;
    const b = boarded(t, id);
    const d = droppedOff(b, id);
    const c = dispatched();
    const cancelled = ok(R.cancel(first(c.s, c.id).state, c.id)).state;
    for (const [state, rid] of [[t, id], [b, id], [d, id], [cancelled, c.id]] as const) {
      const before = snapshot(state);
      expect(code(tapIn(state, rid, at("c")))).toBe("PICKUP_MISMATCH");
      expect(snapshot(state)).toBe(before);
      expect(passenger(state, rid).tappedIn?.locationId).toBe("b");
    }
  });

  it("a replay never touches boarding flags or the request", () => {
    const { s, id } = atPickup();
    const t = first(s, id).state;
    const r = tapIn(t, id, at("b"));
    expect(r.ok && r.state).toBe(t);
    expect(passenger(t, id).boarded).toBe(false);
    expect(t.requests.get(id)!.status).toBe("arriving");
  });

  it("the record survives later operations (start, a shared join, another rider's cancel) unchanged", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = ok(R.createRequest(s, { studentId: LINA, pickupId: "b", destinationId: "d", mode: "shared" }));
    s = a.state;
    const da = dispatchRequest(s, a.request.id);
    if (!da.ok) throw new Error(da.error.message);
    s = first(da.state, a.request.id).state;
    const b = ok(R.createRequest(s, { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" }));
    const db = dispatchRequest(b.state, b.request.id);
    if (!db.ok) throw new Error(db.error.message);
    expect(db.selection.outcome).toBe("joined");
    let after = ok(R.cancel(db.state, b.request.id)).state;
    after = ok(R.startTrip(after, a.request.id)).state;
    expect(passenger(after, a.request.id).tappedIn).toEqual({ locationId: "b", atMs: 0 });
    expect(R.checkRideInvariants(after)).toEqual([]);
  });

  it("the invariant refuses a record naming a location the campus does not have", () => {
    const { s, id } = dispatched();
    const trip = R.tripForRequest(s, id)!;
    const bad = R.makeTrip({ ...trip, passengers: trip.passengers.map((p) => ({ ...p, tappedIn: { locationId: "gone", atMs: 0 } })) });
    expect(R.checkRideInvariants(R.withChanges(s, { trips: [bad] })).join(" ")).toMatch(/tapped in at unknown location "gone"/);
  });
});
