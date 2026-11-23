/**
 * Campus checks that need the graph or the map geometry, run after the Zod schema has accepted the file.
 * Pure functions: imports only from shared and the graph module.
 *
 * - errors:   the campus cannot be operated and must not be loaded.
 * - warnings: suspicious data that may still be intended; shown at startup for someone to review.
 * - connectivity: the full topology report, for diagnostics and tests.
 */
import type { CampusConfig } from "../shared/schemas.js";
import { analyzeConnectivity, buildGraph, canReachTo, reachableFrom, type ConnectivityReport } from "./campusGraph.js";

/**
 * A path's length is compared with the straight-line map distance between its ends, scaled by the
 * campus's own typical meters-per-map-unit (the median over its paths). Map units are abstract, so the
 * scale comes from the file itself, not from real geography.
 * Shorter than this fraction of the expected length: the length or a coordinate is probably wrong.
 */
export const LENGTH_TOO_SHORT_RATIO = 0.8;
/** Longer than this multiple: fine for a winding path, but worth a look. */
export const LENGTH_TOO_LONG_RATIO = 2;

export interface CampusCheck {
  errors: string[];
  warnings: string[];
  connectivity: ConnectivityReport;
  /** Median of lengthMeters / map distance over the campus's paths, or null when it cannot be computed. */
  metersPerMapUnit: number | null;
}

const list = (ids: string[]) => ids.join(", ");

/**
 * Connectivity rule: every location must be reachable from, and able to drive back to, a reference
 * location (the depot when there is one). That is the same as strong connectivity.
 * Why it is required here: carts serve rides between any two stops and must be able to return to the
 * depot to charge (15% battery reserve), so a one-way dead end would strand a cart, and a location no
 * cart can reach cannot be served. Weak connectivity alone (directions ignored) is not enough.
 */
export function checkCampus(campus: CampusConfig): CampusCheck {
  const graph = buildGraph(campus);
  const connectivity = analyzeConnectivity(graph);
  const errors: string[] = [];
  const warnings: string[] = [];

  // ----- Connectivity (errors) -----
  if (!connectivity.weaklyConnected) {
    const sections = connectivity.weakComponents.map((c) => `[${list(c)}]`).join(" / ");
    errors.push(`The campus is split into ${connectivity.weakComponents.length} separate sections with no path between them: ${sections}.`);
  }
  const depot = campus.locations.filter((l) => l.type === "depot").map((l) => l.id).sort()[0];
  const ref = depot ?? graph.locationIds[0]!;
  const fromRef = reachableFrom(graph, ref);
  const toRef = canReachTo(graph, ref);
  const cannotReach = graph.locationIds.filter((id) => !fromRef.has(id));
  const cannotReturn = graph.locationIds.filter((id) => !toRef.has(id));
  if (cannotReach.length) {
    errors.push(`From "${ref}", no cart can reach: ${list(cannotReach)}. Add a path, or check the direction of one-way paths.`);
  }
  if (cannotReturn.length) {
    errors.push(`No cart can drive back to "${ref}" from: ${list(cannotReturn)}. A cart going there would be stranded; check one-way paths.`);
  }

  // ----- Map consistency (warnings) -----
  const pos = new Map(campus.locations.map((l) => [l.id, l.position]));
  for (const l of campus.locations) {
    const { x, y } = l.position;
    if (x < 0 || y < 0 || x > campus.map.width || y > campus.map.height) {
      warnings.push(`Location "${l.id}" at (${x}, ${y}) is outside the ${campus.map.width}x${campus.map.height} map and will be drawn off-screen.`);
    }
  }
  const byPosition = new Map<string, string[]>();
  for (const l of campus.locations) {
    const key = `${l.position.x},${l.position.y}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), l.id]);
  }
  for (const [key, ids] of byPosition) {
    if (ids.length > 1) warnings.push(`Locations ${list(ids.map((i) => `"${i}"`))} share the same map position (${key}); their markers will overlap.`);
  }

  const byPair = new Map<string, string[]>();
  for (const p of campus.paths) {
    const key = [p.from, p.to].sort().join(" <-> ");
    byPair.set(key, [...(byPair.get(key) ?? []), p.id]);
  }
  for (const [pair, ids] of byPair) {
    if (ids.length > 1) warnings.push(`Paths ${list(ids.map((i) => `"${i}"`))} all connect ${pair}. Routing uses the shortest; remove duplicates unless they are really separate roads.`);
  }

  const ratios = campus.paths.flatMap((p) => {
    const a = pos.get(p.from)!;
    const b = pos.get(p.to)!;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return d > 0 ? [{ p, d, ratio: p.lengthMeters / d }] : [];
  });
  const sorted = ratios.map((r) => r.ratio).sort((a, b) => a - b);
  const metersPerMapUnit = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  // With fewer than 3 paths the median says little about the campus's scale.
  if (metersPerMapUnit !== null && sorted.length >= 3) {
    for (const { p, d, ratio } of ratios) {
      const expected = Math.round(d * metersPerMapUnit);
      if (ratio < metersPerMapUnit * LENGTH_TOO_SHORT_RATIO) {
        warnings.push(`Path "${p.id}" is ${p.lengthMeters} m, but its ends are about ${expected} m apart on the map at this campus's scale. Check the length or the coordinates.`);
      } else if (ratio > metersPerMapUnit * LENGTH_TOO_LONG_RATIO) {
        warnings.push(`Path "${p.id}" is ${p.lengthMeters} m, more than ${LENGTH_TOO_LONG_RATIO}x the ~${expected} m its ends are apart on the map. Fine if it winds; otherwise check it.`);
      }
    }
  }

  return { errors, warnings, connectivity, metersPerMapUnit };
}
