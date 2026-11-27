/**
 * Mission Mode (roadmap Phase 7, delivered in the final Phase 6 pass): a deterministic, headless comparison
 * of two dispatch policies on the SAME seeded demand, fleet and campus. It runs on a private copy built from
 * the campus and the current fleet's carts; the live ride state is never read for rides and never changed.
 *
 * - "Pooling on": the Jeeny AI Mobility Engine as it runs live. Requests keep their Solo/Shared mode, so a
 *   Shared request may join a compatible trip within the approved delay cap (engine dispatchRequest).
 * - "Pooling off" (baseline): the same demand with every request solo, dispatched first come, first served by
 *   the same nearest-cart ranking, so the only difference is pooling.
 * In this headless run the simulator itself performs each driver step (start, board, drop-off) as soon as
 * the server's own rules allow it. Every figure is counted from the events of that run; nothing is estimated.
 */
import type { CampusConfig, Cart } from "../shared/schemas";
import { createFleet } from "./fleet";
import { dispatchRequest } from "./dispatch";
import { board, createRequest, createRideState, dropOff, startTrip, type RideState } from "./rides";
import { advance } from "./simulation";

export interface MissionOptions {
  seed: number;
  /** Number of ride requests in the scenario. */
  requests: number;
  /** Share of requests asking for a Shared ride, 0 to 1. */
  sharedShare: number;
  /** Requests arrive within this window (simulated seconds). */
  windowSeconds: number;
  /** Stop the run after this many simulated seconds. */
  limitSeconds: number;
}

export interface MissionDemand { atSeconds: number; studentId: string; pickupId: string; destinationId: string; mode: "solo" | "shared" }

export interface PolicyResult {
  policy: "pooling_on" | "pooling_off";
  completed: number;
  unserved: number;
  /** Request to boarding, simulated seconds, over completed rides. */
  avgWaitSeconds: number | null;
  maxWaitSeconds: number | null;
  /** Boarding to drop-off, simulated seconds, over completed rides. */
  avgRideSeconds: number | null;
  /** Sum of every trip's actual driving time. */
  cartDrivingSeconds: number;
  trips: number;
  sharedTrips: number;
  ridersOnSharedTrips: number;
  finishedAtSeconds: number;
}

export interface MissionResult { options: MissionOptions; demand: MissionDemand[]; carts: number; results: [PolicyResult, PolicyResult] }

export const MISSION_DEFAULTS: MissionOptions = { seed: 7, requests: 12, sharedShare: 0.5, windowSeconds: 900, limitSeconds: 7200 };
const STEP_SECONDS = 5;

/** mulberry32: a small, fixed pseudo-random generator, so a seed always gives the same scenario. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seeded demand: arrival times, pickups and destinations from the campus's stops, and modes. */
export function missionDemand(campus: CampusConfig, o: MissionOptions): MissionDemand[] {
  const rand = rng(o.seed);
  const stops = campus.locations.filter((l) => l.canStop).map((l) => l.id);
  const pickups = campus.locations.filter((l) => l.canStop && l.type === "pickup").map((l) => l.id);
  const fromPool = pickups.length ? pickups : stops;
  const out: MissionDemand[] = [];
  for (let i = 0; i < o.requests; i++) {
    const pickupId = fromPool[Math.floor(rand() * fromPool.length)]!;
    let destinationId = pickupId;
    while (destinationId === pickupId) destinationId = stops[Math.floor(rand() * stops.length)]!;
    out.push({ atSeconds: Math.round(rand() * o.windowSeconds), studentId: `mission-${String(i + 1).padStart(2, "0")}`, pickupId, destinationId, mode: rand() < o.sharedShare ? "shared" : "solo" });
  }
  return out.sort((a, b) => a.atSeconds - b.atSeconds || (a.studentId < b.studentId ? -1 : 1));
}

/** The same starting fleet for both runs: every cart idle and empty where it stands (on a path: at the path's start). */
function freshState(campus: CampusConfig, carts: readonly Cart[]): RideState {
  const startOf = (c: Cart) => (c.position.kind === "at" ? c.position.locationId : campus.paths.find((p) => p.id === (c.position as { pathId: string }).pathId)!.from);
  const fleet = createFleet(campus, carts.map((c) => ({ ...c, status: c.status === "charging" || c.status === "offline" || c.status === "maintenance" ? c.status : "idle", passengerCount: 0, position: { kind: "at", locationId: startOf(c) } })));
  if (!fleet.ok) throw new Error(fleet.errors.map((e) => e.message).join("; "));
  const s = createRideState(campus, fleet.fleet);
  if (!s.ok) throw new Error(s.error.message);
  return s.state;
}

function runPolicy(campus: CampusConfig, carts: readonly Cart[], demand: MissionDemand[], o: MissionOptions, pooling: boolean): PolicyResult {
  let s = freshState(campus, carts);
  const created = new Map<string, number>(); // request id -> created at (s)
  const boardedAt = new Map<string, number>();
  const doneAt = new Map<string, number>();
  let next = 0;
  const apply = (r: { ok: true; state: RideState } | { ok: false }) => { if (r.ok) s = r.state; return r.ok; };

  for (let t = 0; t <= o.limitSeconds; t += STEP_SECONDS) {
    while (next < demand.length && demand[next]!.atSeconds <= s.clockSeconds) {
      const d = demand[next++]!;
      const r = createRequest(s, { studentId: d.studentId, pickupId: d.pickupId, destinationId: d.destinationId, mode: pooling ? d.mode : "solo" });
      if (r.ok) { s = r.state; created.set(r.request.id, s.clockSeconds); }
    }
    // First come, first served: each waiting request is offered to dispatch in creation order.
    for (const r of [...s.requests.values()].filter((x) => x.status === "requested").sort((a, b) => (a.id < b.id ? -1 : 1))) apply(dispatchRequest(s, r.id));
    for (const trip of [...s.trips.values()]) {
      if (trip.status === "planned") {
        const first = trip.passengers.find((p) => !p.cancelled && s.requests.get(p.requestId)?.status === "assigned");
        if (first) apply(startTrip(s, first.requestId));
        continue;
      }
      if (trip.status !== "active") continue;
      const stop = trip.stops[trip.stopIndex];
      const cart = s.fleet.carts.get(trip.cartId);
      if (!stop || !cart || cart.position.kind !== "at" || cart.position.locationId !== stop.locationId) continue;
      for (const id of stop.alight) if (s.requests.get(id)?.status === "on_board" && apply(dropOff(s, id))) doneAt.set(id, s.clockSeconds);
      for (const id of stop.board) if (s.requests.get(id)?.status === "arriving" && apply(board(s, id))) boardedAt.set(id, s.clockSeconds);
    }
    const allIn = next >= demand.length;
    const open = [...s.requests.values()].some((r) => r.status !== "completed" && r.status !== "cancelled");
    if (allIn && !open) break;
    const r = advance(s, STEP_SECONDS);
    if (!r.ok) break;
    s = r.state;
  }
  const waits = [...doneAt.keys()].map((id) => boardedAt.get(id)! - created.get(id)!);
  const rides = [...doneAt.keys()].map((id) => doneAt.get(id)! - boardedAt.get(id)!);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const trips = [...s.trips.values()];
  const shared = trips.filter((t) => t.passengers.length > 1);
  return {
    policy: pooling ? "pooling_on" : "pooling_off",
    completed: doneAt.size,
    unserved: demand.length - doneAt.size,
    avgWaitSeconds: avg(waits),
    maxWaitSeconds: waits.length ? Math.max(...waits) : null,
    avgRideSeconds: avg(rides),
    cartDrivingSeconds: trips.reduce((a, t) => a + t.drivenSeconds, 0),
    trips: trips.length,
    sharedTrips: shared.length,
    ridersOnSharedTrips: shared.reduce((a, t) => a + t.passengers.length, 0),
    finishedAtSeconds: s.clockSeconds,
  };
}

/** Run both policies on the same seeded scenario. Pure: same inputs, same numbers. */
export function runMission(campus: CampusConfig, carts: readonly Cart[], options: Partial<MissionOptions> = {}): MissionResult {
  const o = { ...MISSION_DEFAULTS, ...options };
  const demand = missionDemand(campus, o);
  return { options: o, demand, carts: carts.length, results: [runPolicy(campus, carts, demand, o, true), runPolicy(campus, carts, demand, o, false)] };
}
