import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CampusConfig, type CampusConfigInput } from "../shared/schemas";
import { analyzeConnectivity, buildGraph, canReachTo, reachableFrom, routeEtaSeconds, shortestRoute, unreachableLocations } from "./campusGraph";

const campus = CampusConfig.parse(JSON.parse(readFileSync("campus/fictional-campus.json", "utf8")));
const graph = buildGraph(campus);
const ids = campus.locations.map((l) => l.id);

/** Brute-force shortest length (Floyd-Warshall) to check Dijkstra against. */
function allPairs(c: CampusConfig): Map<string, number> {
  const d = new Map<string, number>();
  const k = (a: string, b: string) => `${a}|${b}`;
  const L = c.locations.map((l) => l.id);
  for (const a of L) for (const b of L) d.set(k(a, b), a === b ? 0 : Infinity);
  for (const p of c.paths) {
    d.set(k(p.from, p.to), Math.min(d.get(k(p.from, p.to))!, p.lengthMeters));
    if (!p.oneWay) d.set(k(p.to, p.from), Math.min(d.get(k(p.to, p.from))!, p.lengthMeters));
  }
  for (const m of L) for (const a of L) for (const b of L) {
    const via = d.get(k(a, m))! + d.get(k(m, b))!;
    if (via < d.get(k(a, b))!) d.set(k(a, b), via);
  }
  return d;
}

const tiny = (over: Partial<CampusConfigInput> = {}): CampusConfig =>
  CampusConfig.parse({
    id: "t", name: "T", fictional: true, map: { width: 100, height: 100 },
    locations: ["a", "b", "c", "d"].map((id, i) => ({ id, name: id, type: "pickup", position: { x: i * 10, y: 0 }, canStop: true })),
    paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 100, speedKmh: 10 },
      { id: "bc", from: "b", to: "c", lengthMeters: 100, speedKmh: 20 },
    ],
    ...over,
  });

describe("shortestRoute", () => {
  it("finds a route between every pair of seeded locations, and it is the shortest", () => {
    const truth = allPairs(campus);
    for (const a of ids) for (const b of ids) {
      const r = shortestRoute(graph, a, b);
      expect(r.ok, `${a} -> ${b}`).toBe(true);
      if (!r.ok) continue;
      expect(r.route.lengthMeters).toBeCloseTo(truth.get(`${a}|${b}`)!, 6);
      expect(r.route.locationIds[0]).toBe(a);
      expect(r.route.locationIds.at(-1)).toBe(b);
      expect(r.route.pathIds).toHaveLength(r.route.locationIds.length - 1);
    }
  });

  it("route length equals the sum of its paths", () => {
    const r = shortestRoute(graph, "north-gate", "depot");
    if (!r.ok) throw new Error(r.error.message);
    const sum = r.route.pathIds.reduce((s, id) => s + graph.paths.get(id)!.lengthMeters, 0);
    expect(r.route.lengthMeters).toBe(sum);
  });

  it("returns the same answer every time, whatever order the file lists paths in", () => {
    const shuffled = buildGraph({ ...campus, paths: [...campus.paths].reverse(), locations: [...campus.locations].reverse() });
    for (const a of ids) for (const b of ids) {
      const first = shortestRoute(graph, a, b);
      expect(shortestRoute(graph, a, b)).toEqual(first);
      expect(shortestRoute(shuffled, a, b)).toEqual(first);
    }
  });

  it("breaks equal-length ties deterministically", () => {
    // Two equal routes a->d: via b and via c.
    const c = tiny({
      paths: [
        { id: "ac", from: "a", to: "c", lengthMeters: 50, speedKmh: 10, oneWay: false },
        { id: "cd", from: "c", to: "d", lengthMeters: 50, speedKmh: 10, oneWay: false },
        { id: "ab", from: "a", to: "b", lengthMeters: 50, speedKmh: 10, oneWay: false },
        { id: "bd", from: "b", to: "d", lengthMeters: 50, speedKmh: 10, oneWay: false },
      ],
    });
    const r1 = shortestRoute(buildGraph(c), "a", "d");
    const r2 = shortestRoute(buildGraph({ ...c, paths: [...c.paths].reverse() }), "a", "d");
    expect(r1).toEqual(r2);
    if (r1.ok) expect(r1.route.locationIds).toEqual(["a", "b", "d"]);
  });

  it("a route to the same place is empty", () => {
    expect(shortestRoute(graph, "library", "library")).toEqual({ ok: true, route: { locationIds: ["library"], pathIds: [], lengthMeters: 0 } });
  });

  it("an unreachable location returns a clear error, not a crash", () => {
    const g = buildGraph(tiny());
    const r = shortestRoute(g, "a", "d");
    expect(r).toEqual({ ok: false, error: { code: "UNREACHABLE", from: "a", to: "d", message: 'No drivable route from "a" to "d"' } });
    expect(unreachableLocations(g)).toEqual(["d"]);
  });

  it("an unknown location returns a clear error", () => {
    const r = shortestRoute(graph, "north-gate", "mars");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNKNOWN_LOCATION");
  });

  it("respects one-way paths", () => {
    const g = buildGraph(tiny({ paths: [{ id: "ab", from: "a", to: "b", lengthMeters: 100, speedKmh: 10, oneWay: true }, { id: "bc", from: "b", to: "c", lengthMeters: 100, speedKmh: 10, oneWay: false }, { id: "cd", from: "c", to: "d", lengthMeters: 100, speedKmh: 10, oneWay: false }] }));
    expect(shortestRoute(g, "a", "b").ok).toBe(true);
    expect(shortestRoute(g, "b", "a").ok).toBe(false);
  });
});

describe("routeEtaSeconds", () => {
  const g = buildGraph(tiny());
  const r = shortestRoute(g, "a", "c");
  if (!r.ok) throw new Error("setup");

  it("uses the slower of cart speed and path speed on each path", () => {
    // ab: 100 m at min(15,10)=10 km/h = 36 s; bc: 100 m at min(15,20)=15 km/h = 24 s
    expect(routeEtaSeconds(g, r.route, 15)).toBe(60);
  });

  it("a slower cart takes longer, and an empty route takes 0 s", () => {
    expect(routeEtaSeconds(g, r.route, 5)).toBeGreaterThan(routeEtaSeconds(g, r.route, 15));
    expect(routeEtaSeconds(g, { locationIds: ["a"], pathIds: [], lengthMeters: 0 }, 15)).toBe(0);
  });

  it("rejects a non-positive speed", () => {
    expect(() => routeEtaSeconds(g, r.route, 0)).toThrow(RangeError);
  });

  it("gives realistic campus ETAs (gate to gate in a few minutes)", () => {
    const rr = shortestRoute(graph, "north-gate", "south-gate");
    if (!rr.ok) throw new Error(rr.error.message);
    const s = routeEtaSeconds(graph, rr.route, 15);
    expect(s).toBeGreaterThan(60);
    expect(s).toBeLessThan(10 * 60);
  });
});

describe("connectivity", () => {
  const ring = (oneWay: boolean) =>
    tiny({
      paths: [
        { id: "ab", from: "a", to: "b", lengthMeters: 100, speedKmh: 10, oneWay },
        { id: "bc", from: "b", to: "c", lengthMeters: 100, speedKmh: 10, oneWay },
        { id: "cd", from: "c", to: "d", lengthMeters: 100, speedKmh: 10, oneWay },
        { id: "da", from: "d", to: "a", lengthMeters: 100, speedKmh: 10, oneWay },
      ],
    });

  it("the seeded campuses are weakly and strongly connected, with no one-direction-only pairs", () => {
    for (const f of ["campus/fictional-campus.json", "campus/demo-valley.json"]) {
      const r = analyzeConnectivity(buildGraph(CampusConfig.parse(JSON.parse(readFileSync(f, "utf8")))));
      expect(r, f).toMatchObject({ weaklyConnected: true, stronglyConnected: true, oneWayPathIds: [], oneDirectionOnly: [] });
      expect(r.strongComponents).toHaveLength(1);
    }
  });

  it("detects separate campus sections (not even weakly connected)", () => {
    const r = analyzeConnectivity(buildGraph(tiny({ paths: [{ id: "ab", from: "a", to: "b", lengthMeters: 1, speedKmh: 10 }, { id: "cd", from: "c", to: "d", lengthMeters: 1, speedKmh: 10 }] })));
    expect(r.weaklyConnected).toBe(false);
    expect(r.stronglyConnected).toBe(false);
    expect(r.weakComponents).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("a one-way ring is strongly connected: every stop can still reach every other", () => {
    const g = buildGraph(ring(true));
    const r = analyzeConnectivity(g);
    expect(r).toMatchObject({ weaklyConnected: true, stronglyConnected: true, oneWayPathIds: ["ab", "bc", "cd", "da"], oneDirectionOnly: [] });
    // b -> a must go the long way round, never against a one-way path.
    const back = shortestRoute(g, "b", "a");
    expect(back.ok && back.route.pathIds).toEqual(["bc", "cd", "da"]);
  });

  it("a one-way dead end is weakly but not strongly connected, and names the one-direction pairs", () => {
    // a <-> b <-> c two-way, then c -> d one-way with no way back: the M1 trap.
    const g = buildGraph(tiny({ paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 1, speedKmh: 10 },
      { id: "bc", from: "b", to: "c", lengthMeters: 1, speedKmh: 10 },
      { id: "cd", from: "c", to: "d", lengthMeters: 1, speedKmh: 10, oneWay: true },
    ] }));
    // The old single-start check sees nothing wrong from "a".
    expect(unreachableLocations(g)).toEqual([]);
    const r = analyzeConnectivity(g);
    expect(r.weaklyConnected).toBe(true);
    expect(r.stronglyConnected).toBe(false);
    expect(r.strongComponents).toEqual([["a", "b", "c"], ["d"]]);
    expect(r.oneDirectionOnly).toEqual([{ from: "a", to: "d" }, { from: "b", to: "d" }, { from: "c", to: "d" }]);
  });

  it("directional reachability: reachableFrom and canReachTo follow path directions", () => {
    const g = buildGraph(tiny({ paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 1, speedKmh: 10, oneWay: true },
      { id: "bc", from: "b", to: "c", lengthMeters: 1, speedKmh: 10 },
    ] }));
    expect([...reachableFrom(g, "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...reachableFrom(g, "c")].sort()).toEqual(["b", "c"]);
    expect([...canReachTo(g, "a")]).toEqual(["a"]);
    expect([...canReachTo(g, "c")].sort()).toEqual(["a", "b", "c"]);
    expect(shortestRoute(g, "a", "c").ok).toBe(true);
    expect(shortestRoute(g, "c", "a").ok).toBe(false);
    expect(reachableFrom(g, "nowhere").size).toBe(0);
  });

  it("gives the same report whatever order the file lists locations and paths in", () => {
    const c = ring(false);
    const a = analyzeConnectivity(buildGraph(c));
    const b = analyzeConnectivity(buildGraph({ ...c, locations: [...c.locations].reverse(), paths: [...c.paths].reverse() }));
    expect(b).toEqual(a);
  });
});
