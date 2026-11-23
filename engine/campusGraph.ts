/**
 * Campus graph: shortest routes and ETAs.
 * Pure functions: imports only from shared, no network, database or timers.
 */
import type { CampusConfig, Path } from "../shared/schemas.js";

export interface Edge {
  pathId: string;
  to: string;
  lengthMeters: number;
  speedKmh: number;
}

export interface CampusGraph {
  locationIds: string[];
  adjacency: Map<string, Edge[]>;
  paths: Map<string, Path>;
}

export type RouteError =
  | { code: "UNKNOWN_LOCATION"; locationId: string; message: string }
  | { code: "UNREACHABLE"; from: string; to: string; message: string };

export interface Route {
  /** Location ids from start to end, inclusive. */
  locationIds: string[];
  /** Path ids traversed, in order. */
  pathIds: string[];
  lengthMeters: number;
}

export type RouteResult = { ok: true; route: Route } | { ok: false; error: RouteError };

export function buildGraph(campus: CampusConfig): CampusGraph {
  const adjacency = new Map<string, Edge[]>();
  const paths = new Map<string, Path>();
  for (const l of campus.locations) adjacency.set(l.id, []);
  for (const p of campus.paths) {
    paths.set(p.id, p);
    adjacency.get(p.from)?.push({ pathId: p.id, to: p.to, lengthMeters: p.lengthMeters, speedKmh: p.speedKmh });
    if (!p.oneWay) adjacency.get(p.to)?.push({ pathId: p.id, to: p.from, lengthMeters: p.lengthMeters, speedKmh: p.speedKmh });
  }
  // Deterministic neighbour order, independent of file order.
  for (const edges of adjacency.values()) edges.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.pathId < b.pathId ? -1 : 1));
  return { locationIds: campus.locations.map((l) => l.id).sort(), adjacency, paths };
}

/**
 * Shortest route by length (Dijkstra). Equal-length ties break on location id order,
 * so the same campus always gives the same answer regardless of file order.
 */
export function shortestRoute(graph: CampusGraph, from: string, to: string): RouteResult {
  for (const id of [from, to]) {
    if (!graph.adjacency.has(id)) {
      return { ok: false, error: { code: "UNKNOWN_LOCATION", locationId: id, message: `Unknown location "${id}"` } };
    }
  }
  if (from === to) return { ok: true, route: { locationIds: [from], pathIds: [], lengthMeters: 0 } };

  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; pathId: string }>();
  const done = new Set<string>();

  // Campuses are small (tens of nodes), so a linear scan beats a heap for clarity.
  while (true) {
    let current: string | undefined;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (done.has(node)) continue;
      if (d < best || (d === best && current !== undefined && node < current)) {
        best = d;
        current = node;
      }
    }
    if (current === undefined) break;
    if (current === to) break;
    done.add(current);
    for (const e of graph.adjacency.get(current) ?? []) {
      if (done.has(e.to)) continue;
      const nd = best + e.lengthMeters;
      const old = dist.get(e.to);
      if (old === undefined || nd < old - 1e-9) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: current, pathId: e.pathId });
      } else if (Math.abs(nd - old) <= 1e-9) {
        // Equal length: keep the lexicographically smaller predecessor for determinism.
        const p = prev.get(e.to);
        if (p && current < p.node) prev.set(e.to, { node: current, pathId: e.pathId });
      }
    }
  }

  if (!dist.has(to)) {
    return { ok: false, error: { code: "UNREACHABLE", from, to, message: `No drivable route from "${from}" to "${to}"` } };
  }
  const locationIds: string[] = [to];
  const pathIds: string[] = [];
  let node = to;
  while (node !== from) {
    const p = prev.get(node)!;
    pathIds.unshift(p.pathId);
    locationIds.unshift(p.node);
    node = p.node;
  }
  return { ok: true, route: { locationIds, pathIds, lengthMeters: dist.get(to)! } };
}

/**
 * Seconds for a cart at `cartSpeedKmh` to drive a route.
 * On each path the cart goes no faster than the path's typical speed.
 */
export function routeEtaSeconds(graph: CampusGraph, route: Route, cartSpeedKmh: number): number {
  if (!(cartSpeedKmh > 0)) throw new RangeError("Cart speed must be greater than 0 km/h");
  let seconds = 0;
  for (const id of route.pathIds) {
    const p = graph.paths.get(id);
    if (!p) throw new Error(`Route uses unknown path "${id}"`);
    const kmh = Math.min(cartSpeedKmh, p.speedKmh);
    seconds += p.lengthMeters / (kmh / 3.6);
  }
  return Math.round(seconds);
}

/** Location ids that cannot be reached from the first location (empty when the campus is connected). */
export function unreachableLocations(graph: CampusGraph): string[] {
  const [start] = graph.locationIds;
  if (start === undefined) return [];
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const n = queue.shift()!;
    for (const e of graph.adjacency.get(n) ?? []) if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
  }
  return graph.locationIds.filter((id) => !seen.has(id));
}
