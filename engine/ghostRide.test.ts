/**
 * Phase 4: Ghost Ride engine. Shared trips, per-rider lifecycle, the shared-plan evaluator (D2 delay
 * rule), joins (Stage 2 planned, Stage 3 moving before boarding; Stage 4 gated off), per-rider
 * cancellation, shared dispatch and drivenSeconds.
 *
 * The line campus (testRideFixtures.ts) is a - b - c - d - e, 100 m apart at 36 km/h: a 36 km/h cart
 * needs exactly 10 s per path, so planned driving times below are exact integers unless stated.
 */
import { describe, expect, it } from "vitest";
import { RiderBaseline, Trip, TripPassenger, type CampusConfig, type CartInput } from "../shared/schemas";
import { SETTINGS } from "../shared/settings";
import * as R from "./rides";
import { advance } from "./simulation";
import { dispatchRequest, soloBaselineForRequest, type DispatchSelection } from "./dispatch";
import { joinTrip } from "./ghostRide";
import { currentDelays, DELAY_EPSILON_SECONDS, evaluateJoin, JOIN_STAGES, MAX_ADDED_DELAY_SECONDS, withinDelayCap } from "./sharedPlan";
import { cartAt, lineCampus, ok, setup, snapshot } from "./testRideFixtures";

const line = lineCampus();
const stop = (id: string) => ({ id, name: id, type: "pickup" as const, position: { x: 10, y: 10 }, canStop: true });
const path = (id: string, from: string, to: string, lengthMeters: number, oneWay = false) => ({ id, from, to, lengthMeters, speedKmh: 36, oneWay });
/** The line campus plus extra stops and paths. */
const extended = (locations: ReturnType<typeof stop>[], paths: ReturnType<typeof path>[]): CampusConfig =>
  lineCampus({ locations: [...line.locations, ...locations], paths: [...line.paths, ...paths] });

type S = R.RideState;
function create(s: S, studentId: string, pickupId: string, destinationId: string, mode: "solo" | "shared" = "shared") {
  const r = ok(R.createRequest(s, { studentId, pickupId, destinationId, mode }));
  return { s: r.state, id: r.request.id };
}
function dispatch(s: S, id: string) {
  const r = dispatchRequest(s, id);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
}
const status = (s: S, id: string) => s.requests.get(id)!.status;
const tripOf = (s: S, id: string) => R.tripForRequest(s, id)!;
const cart = (s: S, id = "CART-01") => s.fleet.carts.get(id)!;
const run = (s: S, seconds: number, tick = seconds) => {
  for (let t = 0; t < seconds - 1e-9; t += tick) s = ok(advance(s, Math.min(tick, seconds - t))).state;
  return s;
};
const delaysOf = (s: S, tripId: string) => {
  const d = currentDelays(s, tripId);
  if (!d.ok) throw new Error(`${d.code}: ${d.reason}`);
  return Object.fromEntries(d.riders.map((r) => [r.requestId, r]));
};
const invariantsHold = (s: S) => expect(R.checkRideInvariants(s)).toEqual([]);

/** A on CART-01 (at a) b -> d, then B c -> e shared; CART-02 at e gives B's solo baseline. */
function twoRiders(carts: CartInput[] = [cartAt("CART-01", "a"), cartAt("CART-02", "e")]) {
  let s = setup(line, carts);
  const a = create(s, "stu-lina", "b", "d"); s = a.s;
  s = dispatch(s, a.id).state;
  const b = create(s, "stu-omar", "c", "e"); s = b.s;
  const d = dispatch(s, b.id);
  return { s: d.state, A: a.id, B: b.id, tripId: tripOf(d.state, a.id).id, selection: d.selection };
}

// ---------------------------------------------------------------------------------------------------
describe("Stage 1: schema and generalised invariants", () => {
  it("adds the approved baseline fields and drivenSeconds, and no delay counter", () => {
    expect(Object.keys(TripPassenger.shape)).toEqual(["requestId", "boarded", "droppedOff", "cancelled", "baseline"]);
    expect(Object.keys(RiderBaseline.shape)).toEqual(["soloPickupSeconds", "soloRideSeconds", "pickupMark", "dropOffMark", "cartId", "recordedAtClock"]);
    expect(Object.keys(Trip.shape)).toContain("drivenSeconds");
    const all = JSON.stringify([Object.keys(Trip.shape), Object.keys(TripPassenger.shape), Object.keys(RiderBaseline.shape)]);
    expect(all).not.toMatch(/addedWait|addedJourney|Counter/i);
  });

  it("old trip shapes still parse, with safe defaults", () => {
    const t = Trip.parse({ id: "t", cartId: "CART-01", stops: [], passengers: [{ requestId: "r", boarded: false }], status: "planned" });
    expect(t.passengers[0]).toEqual({ requestId: "r", boarded: false, droppedOff: false, cancelled: false });
    expect(t.drivenSeconds).toBe(0);
  });

  it("missing, null, negative or non-finite times are rejected by the schema, never turned into 0", () => {
    const base = { soloPickupSeconds: 10, soloRideSeconds: 20, pickupMark: 10, dropOffMark: 30, cartId: "CART-01", recordedAtClock: 0 };
    expect(RiderBaseline.safeParse(base).success).toBe(true);
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, "10"]) {
      for (const k of ["soloPickupSeconds", "soloRideSeconds", "pickupMark", "dropOffMark"] as const) {
        expect(RiderBaseline.safeParse({ ...base, [k]: bad }).success, `${k}=${String(bad)}`).toBe(false);
      }
    }
    expect(RiderBaseline.safeParse({ ...base, soloPickupSeconds: -1 }).success).toBe(false);
    const trip = { id: "t", cartId: "CART-01", stops: [], passengers: [], status: "planned" };
    for (const bad of [NaN, Infinity, -1, null]) expect(Trip.safeParse({ ...trip, drivenSeconds: bad }).success).toBe(false);
  });

  it("solo assignment records the rider's original solo baseline (equal to dispatch's pickup time)", () => {
    let s = setup(line, [cartAt("CART-01", "a")]);
    const a = create(s, "stu-lina", "b", "d", "solo"); s = a.s;
    const d = dispatch(s, a.id);
    const baseline = d.trip.passengers[0]!.baseline!;
    expect(baseline).toEqual({ soloPickupSeconds: 10, soloRideSeconds: 20, pickupMark: 10, dropOffMark: 30, cartId: "CART-01", recordedAtClock: 0 });
    expect(baseline.soloPickupSeconds).toBe(d.selection.candidates[0]!.pickupEtaSeconds);
    expect(d.selection).toEqual({ policy: expect.any(String), selectedCartId: "CART-01", candidates: expect.any(Array) }); // solo selection shape unchanged
  });

  it("invariants refuse a duplicate student, too many committed riders, stops of a cancelled rider and an inconsistent baseline", () => {
    const { s, A, B, tripId } = twoRiders();
    invariantsHold(s);
    const t = s.trips.get(tripId)!;
    const breakTrip = (patch: Partial<Trip>) => R.checkRideInvariants(R.withChanges(s, { trips: [R.makeTrip({ ...t, ...patch })] }));
    // Same student twice.
    const omarAsLina = R.withChanges(s, { requests: [{ ...s.requests.get(B)!, studentId: s.requests.get(A)!.studentId }] });
    expect(R.checkRideInvariants(omarAsLina).join()).toContain("same student twice");
    // A cancelled rider that still has stops.
    expect(breakTrip({ passengers: t.passengers.map((p) => (p.requestId === B ? { ...p, cancelled: true } : p)) }).join()).toContain("still has stops for cancelled rider");
    // Baseline marks out of line.
    expect(breakTrip({ passengers: t.passengers.map((p) => (p.requestId === B ? { ...p, baseline: { ...p.baseline!, dropOffMark: 1 } } : p)) }).join()).toContain("baseline drop-off mark");
    // Committed riders over the seats (shrink the cart to 1 seat through the fleet).
    const oneSeat = R.withChanges(s, { fleet: { ...s.fleet, carts: new Map([...s.fleet.carts].map(([id, c]) => [id, id === "CART-01" ? { ...c, seats: 1 } : c])) } });
    expect(R.checkRideInvariants(oneSeat).join()).toContain("commits 2 riders to 1 seats");
  });
});

// ---------------------------------------------------------------------------------------------------
describe("Stage 2: stop-sequence execution (per-rider boarding and drop-off)", () => {
  it("runs two riders through ordered stops; one ride completes while the shared trip continues", () => {
    let { s, A, B, tripId } = twoRiders();
    expect(s.trips.get(tripId)!.stops.map((x) => x.locationId)).toEqual(["b", "c", "d", "e"]);
    expect([status(s, A), status(s, B)]).toEqual(["assigned", "assigned"]);

    s = ok(R.startTrip(s, A)).state; // starting the trip moves every rider to arriving
    expect([status(s, A), status(s, B)]).toEqual(["arriving", "arriving"]);
    s = run(s, 10);
    expect(R.board(s, B)).toMatchObject({ ok: false, error: { code: "NOT_AT_STOP" } }); // B's pickup is later
    s = ok(R.board(s, A)).state;
    expect(s.trips.get(tripId)).toMatchObject({ stopIndex: 1, leg: { locationIds: ["b", "c"] } });
    expect(cart(s)).toMatchObject({ status: "occupied", passengerCount: 1 });
    s = run(s, 10);
    s = ok(R.board(s, B)).state;
    expect(cart(s)).toMatchObject({ passengerCount: 2 });
    s = run(s, 10);
    expect(R.dropOff(s, B)).toMatchObject({ ok: false, error: { code: "NOT_AT_STOP" } }); // B leaves at e, after d
    const aDone = ok(R.dropOff(s, A));
    s = aDone.state;
    expect(status(s, A)).toBe("completed");
    expect(aDone.trip).toMatchObject({ status: "active", stopIndex: 3 }); // the trip goes on for B
    expect(cart(s)).toMatchObject({ status: "occupied", passengerCount: 1 });
    expect(R.dropOff(s, A)).toMatchObject({ ok: false, error: { code: "RIDE_FINISHED" } });
    s = run(s, 10);
    const bDone = ok(R.dropOff(s, B));
    s = bDone.state;
    expect(bDone.trip).toMatchObject({ status: "completed", stopIndex: 4, leg: null, drivenSeconds: 40 });
    expect(cart(s)).toMatchObject({ status: "idle", passengerCount: 0, position: { kind: "at", locationId: "e" } });
    expect([status(s, A), status(s, B)]).toEqual(["completed", "completed"]);
    invariantsHold(s);
  });

  it("an empty cart between riders goes back to assigned (not idle) while pickups remain", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "c"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "d", "e"); s = dispatch(b.s, b.id).state;
    expect(tripOf(s, a.id).stops.map((x) => x.locationId)).toEqual(["b", "c", "d", "e"]);
    s = ok(R.startTrip(s, a.id)).state;
    s = run(s, 10); s = ok(R.board(s, a.id)).state;
    s = run(s, 10); s = ok(R.dropOff(s, a.id)).state;
    expect(cart(s)).toMatchObject({ status: "assigned", passengerCount: 0 });
    expect(tripOf(s, a.id)).toMatchObject({ status: "active", stopIndex: 2, leg: { locationIds: ["c", "d"] } });
    invariantsHold(s);
    s = run(s, 10); s = ok(R.board(s, b.id)).state;
    s = run(s, 10); s = ok(R.dropOff(s, b.id)).state;
    expect(cart(s)).toMatchObject({ status: "idle", passengerCount: 0 });
    expect(tripOf(s, a.id).status).toBe("completed");
  });

  it("each rider keeps its own fare record: 0.25 JOD per request, no loyalty or payment change", () => {
    let { s, A, B } = twoRiders();
    s = ok(R.startTrip(s, A)).state;
    s = run(s, 10); s = ok(R.board(s, A)).state; s = run(s, 10); s = ok(R.board(s, B)).state;
    s = run(s, 10); s = ok(R.dropOff(s, A)).state; s = run(s, 10); s = ok(R.dropOff(s, B)).state;
    for (const id of [A, B]) {
      expect(s.requests.get(id)).toMatchObject({ mode: "shared", status: "completed", fareJod: SETTINGS.fareJod, freeLoyaltyRide: false });
    }
    expect(SETTINGS.sharedFareJod).toBe(SETTINGS.fareJod);
    // Two completed requests, one per student: never one ride for the group.
    expect([...s.requests.values()].filter((r) => r.status === "completed").map((r) => r.studentId)).toEqual(["stu-lina", "stu-omar"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("drivenSeconds: actual simulated driving time", () => {
  it("grows only while the cart moves; waiting at a stop adds nothing; leftover time at a stop is dropped", () => {
    let s = setup(line, [cartAt("CART-01", "a")]);
    const a = create(s, "stu-lina", "c", "e", "solo"); s = dispatch(a.s, a.id).state;
    const tripId = tripOf(s, a.id).id;
    s = run(s, 30); // planned trip: does not move
    expect(s.trips.get(tripId)!.drivenSeconds).toBe(0);
    s = ok(R.startTrip(s, a.id)).state;
    s = ok(advance(s, 7)).state;
    expect(s.trips.get(tripId)!.drivenSeconds).toBe(7);
    s = ok(advance(s, 25)).state; // 13 s to reach c, then 12 s of leftover dropped
    expect(s.trips.get(tripId)!.drivenSeconds).toBe(20);
    const before = s.trips.get(tripId)!;
    s = ok(advance(s, 60)).state; // waiting at the pickup
    expect(s.trips.get(tripId)).toBe(before); // same object: the trip did not change at all
    expect(s.clockSeconds).toBe(122); // the 30 s spent planned count on the clock, not as driving
  });

  it("the driven total over a leg equals the planned legSecondsLeft at its start, for any tick size", () => {
    const go = (tick: number) => {
      let s = setup(line, [cartAt("CART-01", "a")]);
      const a = create(s, "stu-lina", "e", "a", "solo"); s = dispatch(a.s, a.id).state;
      s = ok(R.startTrip(s, a.id)).state;
      const t = tripOf(s, a.id);
      const planned = R.legSecondsLeft(s.graph, cart(s), t.leg!);
      s = run(s, 41, tick);
      return { planned: planned.ok ? planned.seconds : NaN, driven: tripOf(s, a.id).drivenSeconds };
    };
    for (const tick of [0.1, 0.7, 3, 41]) {
      const r = go(tick);
      expect(r.planned).toBe(40);
      expect(Math.abs(r.driven - r.planned), `tick ${tick}`).toBeLessThan(1e-9);
    }
  });

  it("planned driving time and the simulation use the same speed rule", () => {
    const p = { speedKmh: 12 };
    expect(R.drivingSpeedMps(36, p)).toBe(12 / 3.6);
    expect(R.drivingSpeedMps(9, p)).toBe(9 / 3.6);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("D2 delay rule: cap, epsilon and negative values", () => {
  it("withinDelayCap: <= 240 + 1e-9, no lower bound, no rounding, non-finite never passes", () => {
    expect(MAX_ADDED_DELAY_SECONDS).toBe(240);
    expect(DELAY_EPSILON_SECONDS).toBe(1e-9);
    expect(withinDelayCap(240)).toBe(true);
    expect(withinDelayCap(240 + 5e-10)).toBe(true);
    expect(withinDelayCap(240 + 1e-9)).toBe(true);
    expect(withinDelayCap(240 + 3e-9)).toBe(false);
    expect(withinDelayCap(240.000001)).toBe(false);
    expect(withinDelayCap(-1000)).toBe(true);
    for (const bad of [NaN, Infinity, -Infinity]) expect(withinDelayCap(bad)).toBe(false);
  });

  /**
   * Journey delay: spur c - f of length L and e - g of 1000 m. A (CART-01 from a) rides b -> g.
   * Joiner B rides f -> e; its solo baseline comes from CART-02 parked at f (pickup 0 s, ride L/10 + 20 s).
   * The only sequence within the cap is b, f, e, g, and it adds exactly 2L/10 s to A's journey, 0 to
   * A's wait. L = 1200 gives exactly 240 s.
   */
  function journeyCase(L: number) {
    const campus = extended([stop("f"), stop("g")], [path("cf", "c", "f", L), path("eg", "e", "g", 1000)]);
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "f")]);
    const a = create(s, "stu-lina", "b", "g"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "f", "e"); s = b.s;
    const tripId = tripOf(s, a.id).id;
    return { s, A: a.id, B: b.id, tripId, ev: evaluateJoin(s, tripId, s.requests.get(b.id)!, soloBaselineForRequest(s, b.id)) };
  }

  it("journey delay of exactly 240 s is accepted", () => {
    const { ev, A } = journeyCase(1200);
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    expect(ev.plan.stops.map((x) => x.locationId)).toEqual(["b", "f", "e", "g"]);
    const a = ev.plan.riders.find((r) => r.requestId === A)!;
    expect(a.journeyDelaySeconds).toBe(240);
    expect(a.waitDelaySeconds).toBe(0);
    expect(ev.plan.sequencesWithinCap).toBe(1);
  });

  it("journey delay within the 1e-9 s tolerance is accepted; beyond it is rejected with the rider and measure", () => {
    const within = journeyCase(1200 + 2e-9); // about 240 + 4e-10 s
    expect(within.ev.ok).toBe(true);
    if (within.ev.ok) {
      const d = within.ev.plan.riders.find((r) => r.requestId === within.A)!.journeyDelaySeconds;
      expect(d).toBeGreaterThan(240);
      expect(d - 240).toBeLessThan(1e-9);
    }
    const beyond = journeyCase(1200.00001); // 240.000002 s
    expect(beyond.ev).toMatchObject({ ok: false, code: "DELAY_CAP_EXCEEDED", worst: { requestId: beyond.A, measure: "journey" } });
    if (!beyond.ev.ok) expect(beyond.ev.worst!.seconds).toBeCloseTo(240.000002, 6);
  });

  /**
   * Wait delay: spur e - h of H meters. CART-01 at a takes A (a -> b). Joiner B rides h -> e; its solo
   * baseline is CART-02 parked at h but slow (18 km/h): pickup 0 s, ride H / 5 s. Every shared sequence
   * reaches h after at least 40 + H/10 s, so B's wait delay is 40 + H/10 while its journey delay is
   * (40 + 2H/10) - H/5 = 40 s. H = 2000 gives a wait delay of exactly 240 s.
   */
  function waitCase(H: number) {
    const campus = extended([stop("h")], [path("eh", "e", "h", H)]);
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "h", { maxSpeedKmh: 18 })]);
    const a = create(s, "stu-lina", "a", "b"); s = dispatch(a.s, a.id).state;
    expect(tripOf(s, a.id).cartId).toBe("CART-01");
    const b = create(s, "stu-omar", "h", "e"); s = b.s;
    const tripId = tripOf(s, a.id).id;
    return { s, B: b.id, ev: evaluateJoin(s, tripId, s.requests.get(b.id)!, soloBaselineForRequest(s, b.id)) };
  }

  it("wait delay is measured separately: exactly 240 s accepted, within tolerance accepted, beyond rejected", () => {
    const exact = waitCase(2000);
    expect(exact.ev.ok).toBe(true);
    if (exact.ev.ok) {
      const b = exact.ev.plan.riders.find((r) => r.requestId === exact.B)!;
      expect(b.waitDelaySeconds).toBe(240);
      expect(b.journeyDelaySeconds).toBe(40); // the journey measure alone would not have refused it
    }
    const within = waitCase(2000 + 4e-9);
    expect(within.ev.ok).toBe(true);
    const beyond = waitCase(2000.00001);
    expect(beyond.ev).toMatchObject({ ok: false, code: "DELAY_CAP_EXCEEDED", worst: { requestId: beyond.B, measure: "wait" } });
  });

  it("negative delays are kept as they are (the shared cart is closer than the solo one)", () => {
    const campus = extended([stop("g")], [path("eg", "e", "g", 1000)]);
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "g")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "c", "d"); s = b.s;
    const d = dispatch(s, b.id);
    expect(d.selection.outcome).toBe("joined");
    const bRider = d.selection.joinCandidates![0]!.riders!.find((r) => r.requestId === b.id)!;
    expect(bRider.waitDelaySeconds).toBe(-100); // shared pickup at 20 s vs solo 120 s
    expect(bRider.journeyDelaySeconds).toBe(-100);
    expect(delaysOf(d.state, tripOf(d.state, a.id).id)[b.id]!.waitDelaySeconds).toBe(-100);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("D2 baselines: mandatory, write-once, never zero", () => {
  it("a joining rider without a solo baseline is rejected with SOLO_BASELINE_UNAVAILABLE and the request stays requested", () => {
    let s = setup(line, [cartAt("CART-01", "a")]); // one cart only: busy once A has it
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "c", "e"); s = b.s;
    expect(soloBaselineForRequest(s, b.id)).toBeNull();
    const before = snapshot(s);
    const r = dispatchRequest(s, b.id);
    expect(r).toMatchObject({ ok: false, error: { code: "NO_CART_AVAILABLE" } });
    if (!r.ok) {
      expect(r.error.selection!.soloBaseline).toBeNull();
      expect(r.error.selection!.joinCandidates).toEqual([expect.objectContaining({ tripId: tripOf(s, a.id).id, eligible: false, excludedCode: "SOLO_BASELINE_UNAVAILABLE" })]);
    }
    expect(snapshot(s)).toBe(before);
    expect(status(s, b.id)).toBe("requested");
    // A cart below the battery reserve cannot give a baseline either.
    let s2 = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e", { batteryPercent: 14 })]);
    const a2 = create(s2, "stu-lina", "b", "d"); s2 = dispatch(a2.s, a2.id).state;
    const b2 = create(s2, "stu-omar", "c", "e");
    expect(soloBaselineForRequest(b2.s, b2.id)).toBeNull();
  });

  it("missing, null, negative or non-finite solo values are SOLO_BASELINE_UNAVAILABLE, never a zero baseline", () => {
    const { s, tripId } = twoRiders();
    const c = create(s, "stu-sara", "c", "d");
    const req = c.s.requests.get(c.id)!;
    for (const bad of [null, { soloPickupSeconds: NaN, soloRideSeconds: 10, cartId: "CART-02" }, { soloPickupSeconds: 10, soloRideSeconds: Infinity, cartId: "CART-02" }, { soloPickupSeconds: -1, soloRideSeconds: 10, cartId: "CART-02" }, { soloPickupSeconds: undefined as unknown as number, soloRideSeconds: 10, cartId: "CART-02" }]) {
      expect(evaluateJoin(c.s, tripId, req, bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "SOLO_BASELINE_UNAVAILABLE" });
    }
    expect(joinTrip(c.s, c.id, tripId, null)).toMatchObject({ ok: false, error: { code: "SOLO_BASELINE_UNAVAILABLE" } });
  });

  it("an existing rider without a recorded baseline makes that trip ineligible (RIDER_BASELINE_MISSING)", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const t = tripOf(s, a.id);
    const { baseline: _drop, ...noBaseline } = t.passengers[0]!;
    s = R.withChanges(s, { trips: [R.makeTrip({ ...t, passengers: [noBaseline] })] });
    invariantsHold(s); // a missing baseline is allowed in the state, but never inferred
    const b = create(s, "stu-omar", "c", "e");
    expect(evaluateJoin(b.s, t.id, b.s.requests.get(b.id)!, soloBaselineForRequest(b.s, b.id))).toMatchObject({ ok: false, code: "RIDER_BASELINE_MISSING" });
    expect(currentDelays(b.s, t.id)).toMatchObject({ ok: false, code: "RIDER_BASELINE_MISSING" });
    // Dispatch falls back to a new cart for B (CART-02); nothing is approximated.
    expect(dispatch(b.s, b.id).selection).toMatchObject({ outcome: "new_cart", joinCandidates: [{ excludedCode: "RIDER_BASELINE_MISSING" }] });
  });

  it("an unavailable shared-route metric rejects the candidate with ROUTE_METRIC_UNAVAILABLE", () => {
    // h can only be left (one-way h -> a): the joiner's solo cart parked at h has a baseline, but no
    // stop of the trip can reach h, so the shared plan has no driving time to it.
    const campus = extended([stop("h")], [path("ha", "h", "a", 100, true)]);
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "h")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "h", "a"); s = b.s;
    const solo = soloBaselineForRequest(s, b.id);
    expect(solo).toEqual({ soloPickupSeconds: 0, soloRideSeconds: 10, cartId: "CART-02" });
    const ev = evaluateJoin(s, tripOf(s, a.id).id, s.requests.get(b.id)!, solo);
    expect(ev).toMatchObject({ ok: false, code: "ROUTE_METRIC_UNAVAILABLE" });
    expect(R.routeDrivingSeconds(s.graph, { locationIds: ["a", "h"], pathIds: ["ha"] }, 36)).toMatchObject({ ok: false, error: { code: "ROUTE_METRIC_UNAVAILABLE" } });
    expect(R.routeDrivingSeconds(s.graph, { locationIds: ["a", "b"], pathIds: ["ab"] }, NaN)).toMatchObject({ ok: false, error: { code: "ROUTE_METRIC_UNAVAILABLE" } });
  });

  it("shared evaluation never overwrites an original baseline; repeated evaluation uses the same baseline", () => {
    const { s, A, tripId } = twoRiders();
    const original = structuredClone(tripOf(s, A).passengers[0]!.baseline);
    const c = create(s, "stu-sara", "c", "d");
    const solo = soloBaselineForRequest(c.s, c.id);
    const first = evaluateJoin(c.s, tripId, c.s.requests.get(c.id)!, solo);
    const second = evaluateJoin(c.s, tripId, c.s.requests.get(c.id)!, solo);
    expect(second).toEqual(first);
    expect(tripOf(c.s, A).passengers[0]!.baseline).toEqual(original);
    if (first.ok) expect(first.plan.riders.find((r) => r.requestId === A)!.baseline).toEqual(original);
  });

  it("actual driven time is never used as a planned time: delays stay constant while the cart follows its plan", () => {
    let { s, tripId, A, B } = twoRiders();
    s = ok(R.startTrip(s, A)).state;
    const at0 = delaysOf(s, tripId);
    for (const step of [3, 0.7, 2.3]) {
      s = ok(advance(s, step)).state;
      const now = delaysOf(s, tripId);
      for (const id of [A, B]) {
        expect(Math.abs(now[id]!.journeyDelaySeconds - at0[id]!.journeyDelaySeconds)).toBeLessThan(1e-9);
        expect(Math.abs(now[id]!.waitDelaySeconds! - at0[id]!.waitDelaySeconds!)).toBeLessThan(1e-9);
      }
    }
    // The 4 s left to b: waiting there afterwards changes neither drivenSeconds nor any delay.
    s = run(s, 4);
    const parked = s.trips.get(tripId)!.drivenSeconds;
    s = run(s, 90);
    expect(s.trips.get(tripId)!.drivenSeconds).toBe(parked);
    expect(delaysOf(s, tripId)[A]!.journeyDelaySeconds).toBeCloseTo(at0[A]!.journeyDelaySeconds, 9);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("cumulative joins without double counting", () => {
  /**
   * Spurs c - f (600 m), d - h (L2 m) and e - g (1000 m). A (CART-01 from a) rides b -> g. B (baseline
   * CART-02 at f) rides f -> e: serving B after g would put B's wait at 320 s, so B is inserted before e
   * and adds 2 * 600 / 10 = 120 s to A's journey. C (baseline CART-03 at h) rides h -> e.
   */
  function threeRiders(L2: number) {
    const campus = extended([stop("f"), stop("h"), stop("g")], [path("cf", "c", "f", 600), path("dh", "d", "h", L2), path("eg", "e", "g", 1000)]);
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "f"), cartAt("CART-03", "h")]);
    const a = create(s, "stu-lina", "b", "g"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "f", "e"); s = dispatch(b.s, b.id).state;
    expect(tripOf(s, b.id).id).toBe(tripOf(s, a.id).id);
    return { s, A: a.id, B: b.id, tripId: tripOf(s, a.id).id };
  }

  it("join 1 puts A at 120 s; a later join that leaves A's drop-off alone keeps 120 s (not 240)", () => {
    let { s, A, tripId } = threeRiders(300);
    expect(delaysOf(s, tripId)[A]!.journeyDelaySeconds).toBe(120);
    s = ok(R.startTrip(s, A)).state;
    s = run(s, 10); s = ok(R.board(s, A)).state; // cart moves along the plan; A is on board
    expect(delaysOf(s, tripId)[A]!.journeyDelaySeconds).toBe(120);
    // Stage 4 is gated off, so a join now is refused; the cumulative case is shown before boarding below.
    const c = create(s, "stu-sara", "c", "e");
    expect(dispatch(c.s, c.id).selection.joinCandidates![0]).toMatchObject({ excludedCode: "STAGE_NOT_ALLOWED" });
  });

  it("join 2 that adds 60 s more gives 180 s (not 300); one that would reach 250 s is refused", () => {
    // Before anyone boards: Stage 2 (planned) joins.
    const base = threeRiders(300);
    let s = base.s;
    const c = create(s, "stu-sara", "h", "e"); s = c.s;
    const d = dispatch(s, c.id);
    expect(d.selection.outcome).toBe("joined");
    expect(delaysOf(d.state, base.tripId)[base.A]!.journeyDelaySeconds).toBe(180);
    // An on-route join (c -> e) leaves A's delay where it was: 120 s, not 240 s.
    const onRoute = create(base.s, "stu-sara", "c", "e");
    const d2 = dispatch(onRoute.s, onRoute.id);
    expect(d2.selection.outcome).toBe("joined");
    expect(delaysOf(d2.state, base.tripId)[base.A]!.journeyDelaySeconds).toBe(120);
    // Cap creep: a 650 m spur would add 130 s, 120 + 130 = 250 > 240. Each join alone is under the cap.
    const creep = threeRiders(650);
    const e = create(creep.s, "stu-sara", "h", "e");
    const before = snapshot(e.s);
    const r = dispatch(e.s, e.id);
    expect(r.selection.outcome).toBe("new_cart"); // CART-03 takes it solo; the trip is untouched
    expect(r.selection.joinCandidates![0]).toMatchObject({ excludedCode: "DELAY_CAP_EXCEEDED", worst: { requestId: creep.A, measure: "journey", seconds: 250 } });
    expect(snapshot(e.s)).toBe(before);
    expect(r.state.trips.get(creep.tripId)).toBe(e.s.trips.get(creep.tripId)); // the shared trip object is unchanged
  });

  it("cancelling the second joiner recomputes A's delay from the original baseline (back to 120 s)", () => {
    const base = threeRiders(300);
    const c = create(base.s, "stu-sara", "h", "e");
    let s = dispatch(c.s, c.id).state;
    const originalA = structuredClone(tripOf(s, base.A).passengers[0]!.baseline);
    expect(delaysOf(s, base.tripId)[base.A]!.journeyDelaySeconds).toBe(180);
    s = ok(R.cancel(s, c.id)).state;
    expect(delaysOf(s, base.tripId)[base.A]!.journeyDelaySeconds).toBe(120);
    expect(tripOf(s, base.A).passengers[0]!.baseline).toEqual(originalA);
    expect(status(s, base.A)).toBe("assigned");
    invariantsHold(s);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("join eligibility: stages, sharing, seats, students, battery", () => {
  it("Stage 2: a planned trip takes a shared rider; existing stop order is preserved", () => {
    const { s, A, B, tripId, selection } = twoRiders();
    expect(selection).toMatchObject({ mode: "shared", outcome: "joined", selectedTripId: tripId, selectedCartId: "CART-01", soloBaseline: { cartId: "CART-02" } });
    const t = s.trips.get(tripId)!;
    expect(t.passengers.map((p) => p.requestId)).toEqual([A, B]);
    const order = t.stops.map((x) => x.locationId);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d")); // A's own order kept
    expect(cart(s).status).toBe("assigned");
    invariantsHold(s);
  });

  it("Stage 4 stays disabled: no join once any rider has boarded", () => {
    expect(JOIN_STAGES).toEqual({ plannedTrip: true, movingBeforeBoarding: true, afterBoarding: false });
    expect(Object.isFrozen(JOIN_STAGES)).toBe(true);
    let { s, A, tripId } = twoRiders();
    s = ok(R.startTrip(s, A)).state; s = run(s, 10); s = ok(R.board(s, A)).state;
    const c = create(s, "stu-sara", "c", "d");
    expect(evaluateJoin(c.s, tripId, c.s.requests.get(c.id)!, { soloPickupSeconds: 1, soloRideSeconds: 1, cartId: "CART-02" })).toMatchObject({ ok: false, code: "STAGE_NOT_ALLOWED" });
  });

  it("a solo rider is never pooled, and a solo request never joins", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "d", "solo"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "c", "e"); s = b.s;
    const d = dispatch(s, b.id);
    expect(d.selection).toMatchObject({ outcome: "new_cart", selectedCartId: "CART-02", joinCandidates: [{ excludedCode: "TRIP_NOT_SHARED" }] });
    let s2 = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a2 = create(s2, "stu-lina", "b", "d"); s2 = dispatch(a2.s, a2.id).state;
    const b2 = create(s2, "stu-omar", "c", "e", "solo");
    const d2 = dispatch(b2.s, b2.id);
    expect(d2.selection.joinCandidates).toBeUndefined();
    expect(d2.selection.selectedCartId).toBe("CART-02");
    expect(joinTrip(b2.s, b2.id, tripOf(b2.s, a2.id).id, soloBaselineForRequest(b2.s, b2.id))).toMatchObject({ ok: false, error: { code: "REQUEST_NOT_SHARED" } });
  });

  it("the same student cannot join a trip twice", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-lina", "c", "e");
    expect(dispatch(b.s, b.id).selection).toMatchObject({ outcome: "new_cart", joinCandidates: [{ excludedCode: "SAME_STUDENT" }] });
  });

  it("seats count committed riders (waiting ones included), not only those on board", () => {
    let s = setup(line, [cartAt("CART-01", "a", { seats: 2 }), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "c", "e"); s = dispatch(b.s, b.id).state;
    expect(cart(s).passengerCount).toBe(0); // nobody on board yet
    const c = create(s, "stu-sara", "c", "d");
    expect(evaluateJoin(c.s, tripOf(s, a.id).id, c.s.requests.get(c.id)!, soloBaselineForRequest(c.s, c.id))).toMatchObject({ ok: false, code: "TRIP_FULL" });
  });

  it("a cart below the 15% battery reserve takes no new rider; a cancelling trip is not joinable", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const low = ok(R.updateCartInRide(s, "CART-01", { batteryPercent: 14.9 })).state;
    const b = create(low, "stu-omar", "c", "e");
    expect(evaluateJoin(b.s, tripOf(low, a.id).id, b.s.requests.get(b.id)!, soloBaselineForRequest(b.s, b.id))).toMatchObject({ ok: false, code: "CART_INELIGIBLE" });
    s = ok(R.startTrip(s, a.id)).state; s = run(s, 5); s = ok(R.cancel(s, a.id)).state;
    expect(tripOf(s, a.id).status).toBe("cancelling");
    const c = create(s, "stu-omar", "c", "e");
    expect(evaluateJoin(c.s, tripOf(s, a.id).id, c.s.requests.get(c.id)!, soloBaselineForRequest(c.s, c.id))).toMatchObject({ ok: false, code: "TRIP_NOT_JOINABLE" });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("Stage 8: moving-trip joins before boarding", () => {
  it("joins while the cart stands at a location (at A's pickup, nobody boarded)", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    s = ok(R.startTrip(s, a.id)).state; s = run(s, 10);
    const b = create(s, "stu-omar", "c", "e"); s = b.s;
    const d = dispatch(s, b.id);
    expect(d.selection).toMatchObject({ outcome: "joined", joinCandidates: [{ stage: "moving" }] });
    expect(status(d.state, b.id)).toBe("arriving"); // the trip already started
    expect(tripOf(d.state, a.id).leg).toEqual(tripOf(s, a.id).leg); // still heading to b: leg kept
    invariantsHold(d.state);
  });

  it("joins mid-path: a new first stop keeps the current path and direction, then re-routes", () => {
    const campus = extended([stop("g")], [path("eg", "e", "g", 1000)]);
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "g")]);
    const a = create(s, "stu-lina", "d", "e"); s = dispatch(a.s, a.id).state;
    s = ok(R.startTrip(s, a.id)).state; s = run(s, 15); // halfway along b - c, heading to d
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "bc", progress: 0.5 });
    const b = create(s, "stu-omar", "c", "d"); s = b.s;
    const d = dispatch(s, b.id);
    expect(d.selection.outcome).toBe("joined");
    const t = tripOf(d.state, a.id);
    expect(t.stops.map((x) => x.locationId)).toEqual(["c", "d", "d", "e"]);
    expect(t.leg).toEqual({ locationIds: ["b", "c"], pathIds: ["bc"] }); // the path it is on, same direction
    expect(cart(d.state).position).toEqual(cart(s).position); // the cart did not move or jump
    invariantsHold(d.state);
    // Run the shared trip to the end.
    let x = run(d.state, 5); x = ok(R.board(x, b.id)).state;
    x = run(x, 10); x = ok(R.dropOff(x, b.id)).state; x = ok(R.board(x, a.id)).state; // stop order: B leaves d, then A boards there
    x = run(x, 10); x = ok(R.dropOff(x, a.id)).state;
    expect(tripOf(x, a.id)).toMatchObject({ status: "completed" });
    expect(Math.abs(tripOf(x, a.id).drivenSeconds - 40)).toBeLessThan(1e-9);
    invariantsHold(x);
  });

  it("joins mid-path when the new pickup is behind the cart: it finishes the path, then comes back", () => {
    // A rides d -> g (g 1000 m past e) so serving B after A would break B's wait cap (255 s); the cheapest
    // plan for A is to fetch B first (+20 s for A), which needs a U-turn at c.
    const campus = extended([stop("g")], [path("eg", "e", "g", 1000)]);
    let s = setup(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "a")]);
    const a = create(s, "stu-lina", "d", "g"); s = dispatch(a.s, a.id).state;
    expect(tripOf(s, a.id).cartId).toBe("CART-01");
    s = ok(R.startTrip(s, a.id)).state; s = run(s, 15); // mid b - c heading to d
    expect(cart(s).position).toEqual({ kind: "on_path", pathId: "bc", progress: 0.5 });
    const b = create(s, "stu-omar", "b", "e"); s = b.s;
    const d = dispatch(s, b.id);
    expect(d.selection.outcome).toBe("joined");
    const t = tripOf(d.state, a.id);
    expect(t.stops[0]!.locationId).toBe("b");
    expect(t.leg).toEqual({ locationIds: ["b", "c", "b"], pathIds: ["bc", "bc"] }); // no U-turn mid-path
    invariantsHold(d.state);
    let x = run(d.state, 5); // reaches c
    invariantsHold(x);
    x = run(x, 5); // halfway back along b - c
    expect(cart(x).position).toEqual({ kind: "on_path", pathId: "bc", progress: 0.5 });
    invariantsHold(x);
    x = run(x, 5);
    expect(cart(x).position).toEqual({ kind: "at", locationId: "b" });
    x = ok(R.board(x, b.id)).state;
    invariantsHold(x);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("Stage 5: per-rider cancellation", () => {
  it("cancelling one waiting rider on a planned trip keeps the other rider's ride", () => {
    let { s, A, B, tripId } = twoRiders();
    const aBefore = s.requests.get(A);
    const r = ok(R.cancel(s, B));
    s = r.state;
    expect(status(s, B)).toBe("cancelled");
    expect(s.requests.get(A)).toBe(aBefore); // untouched
    expect(r.trip).toMatchObject({ status: "planned", stops: [{ locationId: "b" }, { locationId: "d" }] });
    expect(s.trips.get(tripId)!.passengers.find((p) => p.requestId === B)).toMatchObject({ cancelled: true, boarded: false });
    expect(R.tripForRequest(s, B)!.id).toBe(tripId); // history kept
    invariantsHold(s);
    // The last rider cancelling cancels the whole trip, as in Part 3.
    s = ok(R.cancel(s, A)).state;
    expect(s.trips.get(tripId)!.status).toBe("cancelled");
    expect(cart(s).status).toBe("idle");
    invariantsHold(s);
  });

  it("a rider on board cannot cancel; cancelling the other rider mid-path re-plans the route", () => {
    let { s, A, B, tripId } = twoRiders(); // stops b, c, d, e
    s = ok(R.startTrip(s, A)).state; s = run(s, 10); s = ok(R.board(s, A)).state;
    expect(R.cancel(s, A)).toMatchObject({ ok: false, error: { code: "CANNOT_CANCEL_ON_BOARD" } });
    s = run(s, 5); // mid b - c, heading to B's pickup at c
    const r = ok(R.cancel(s, B));
    s = r.state;
    expect(r.trip).toMatchObject({ status: "active", stops: [{ locationId: "b" }, { locationId: "d" }], stopIndex: 1, leg: { locationIds: ["b", "c", "d"], pathIds: ["bc", "cd"] } });
    expect(cart(s)).toMatchObject({ status: "occupied", passengerCount: 1, position: { kind: "on_path", pathId: "bc", progress: 0.5 } });
    expect(status(s, A)).toBe("on_board");
    invariantsHold(s);
    s = run(s, 15); s = ok(R.dropOff(s, A)).state;
    expect(s.trips.get(tripId)!.status).toBe("completed");
    expect(cart(s).status).toBe("idle");
  });

  it("is never refused because the new route changes a delay", () => {
    // B's cancel forces the cart to finish its current path first, so A's remaining time can change;
    // the cancellation still goes through and delays are simply recomputed.
    let { s, A, B, tripId } = twoRiders();
    s = ok(R.startTrip(s, A)).state; s = run(s, 3);
    expect(R.cancel(s, B).ok).toBe(true);
    const after = ok(R.cancel(s, B)).state;
    expect(delaysOf(after, tripId)[A]).toBeDefined();
  });

  it("when everyone else was dropped off, cancelling the last waiting rider completes the trip", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = create(s, "stu-lina", "b", "c"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "d", "e"); s = dispatch(b.s, b.id).state;
    s = ok(R.startTrip(s, a.id)).state;
    s = run(s, 10); s = ok(R.board(s, a.id)).state; s = run(s, 10); s = ok(R.dropOff(s, a.id)).state;
    // At c, heading to B's pickup at d. Cancel at the location:
    const atLoc = ok(R.cancel(s, b.id));
    expect(atLoc.trip).toMatchObject({ status: "completed", leg: null });
    expect(cart(atLoc.state)).toMatchObject({ status: "idle" });
    invariantsHold(atLoc.state);
    // Cancel mid-path instead: the cart finishes its path, then the trip completes (it carried A).
    let m = run(s, 5);
    m = ok(R.cancel(m, b.id)).state;
    expect(tripOf(m, a.id)).toMatchObject({ status: "cancelling" });
    invariantsHold(m);
    m = run(m, 5);
    expect(tripOf(m, a.id)).toMatchObject({ status: "completed", leg: null });
    expect(cart(m)).toMatchObject({ status: "idle", position: { kind: "at", locationId: "d" } });
    expect([status(m, a.id), status(m, b.id)]).toEqual(["completed", "cancelled"]);
    invariantsHold(m);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("determinism and atomicity", () => {
  const shuffle = (s: S): S => Object.freeze({ ...s, trips: new Map([...s.trips].reverse()), requests: new Map([...s.requests].reverse()) });

  it("the same input in a different Map insertion order gives an identical shared dispatch", () => {
    let s = setup(line, [cartAt("CART-01", "a"), cartAt("CART-02", "a"), cartAt("CART-03", "e")]);
    const a = create(s, "stu-lina", "b", "d"); s = dispatch(a.s, a.id).state;
    const b = create(s, "stu-omar", "b", "c", "solo"); s = dispatch(b.s, b.id).state; // CART-02, solo
    const c = create(s, "stu-sara", "c", "e"); s = c.s;
    const one = dispatch(s, c.id);
    const two = dispatch(shuffle(s), c.id);
    expect(JSON.stringify(two.selection)).toBe(JSON.stringify(one.selection));
    const sorted = (x: S) => JSON.stringify([[...x.requests.values()].sort((p, q) => p.id.localeCompare(q.id)), [...x.trips.values()].sort((p, q) => p.id.localeCompare(q.id)), [...x.fleet.carts.values()]]);
    expect(sorted(two.state)).toBe(sorted(one.state));
    expect(two.trip).toEqual(one.trip);
    expect(one.selection.joinCandidates!.map((j) => j.tripId)).toEqual(["TRIP-0001", "TRIP-0002"]); // trip id order
  });

  it("a failed join leaves every request, trip, cart and passenger exactly as it was", () => {
    const { s, tripId } = twoRiders();
    const c = create(s, "stu-lina", "c", "d"); // same student as A
    const before = snapshot(c.s);
    const r = joinTrip(c.s, c.id, tripId, soloBaselineForRequest(c.s, c.id));
    expect(r).toMatchObject({ ok: false, error: { code: "SAME_STUDENT" } });
    expect(snapshot(c.s)).toBe(before);
    expect(joinTrip(c.s, "REQ-9999", tripId, null)).toMatchObject({ ok: false, error: { code: "UNKNOWN_REQUEST" } });
    expect(snapshot(c.s)).toBe(before);
  });

  it("a successful dispatch never changes the state it was given", () => {
    const { s } = twoRiders();
    const c = create(s, "stu-sara", "c", "d");
    const before = snapshot(c.s);
    dispatch(c.s, c.id);
    expect(snapshot(c.s)).toBe(before);
  });

  it("the shared dispatch explanation names every open trip and the rules used", () => {
    const { selection } = twoRiders();
    const sel = selection as DispatchSelection;
    expect(sel.policy).toMatch(/solo baseline/);
    expect(sel.maxAddedDelaySeconds).toBe(240);
    expect(sel.delayEpsilonSeconds).toBe(1e-9);
    expect(sel.joinCandidates![0]).toMatchObject({ eligible: true, rank: 1, sequencesChecked: 6, riders: [expect.objectContaining({ joining: false }), expect.objectContaining({ joining: true })] });
  });
});
