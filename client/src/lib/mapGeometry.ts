import type { CampusConfig, LocationType } from "../../../shared/schemas";

export interface Segment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Drawn with a direction arrow; carts may only drive from (x1,y1) to (x2,y2). */
  oneWay: boolean;
}

/** Turn campus paths into drawable line segments. Pure, so it is tested without a browser. */
export function pathSegments(campus: CampusConfig): Segment[] {
  const pos = new Map(campus.locations.map((l) => [l.id, l.position]));
  return campus.paths.flatMap((p) => {
    const a = pos.get(p.from);
    const b = pos.get(p.to);
    return a && b ? [{ id: p.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, oneWay: p.oneWay }] : [];
  });
}

export const LOCATION_TYPE_LABEL: Record<LocationType, string> = {
  gate: "Gate",
  building: "Building",
  parking: "Parking",
  pickup: "Pickup point",
  depot: "Cart depot",
};

/** Label scale so text stays readable whatever size the campus map is. */
export function labelSize(campus: CampusConfig): number {
  return Math.max(12, Math.round(Math.max(campus.map.width, campus.map.height) / 48));
}

/**
 * Chevron at the middle of a one-way segment, pointing in the allowed direction.
 * Returns an SVG path "d" string, or null for a zero-length segment.
 */
export function oneWayArrow(s: Segment, size: number): string | null {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;
  const mx = (s.x1 + s.x2) / 2;
  const my = (s.y1 + s.y2) / 2;
  const tip = { x: mx + ux * size * 0.5, y: my + uy * size * 0.5 };
  const back = { x: mx - ux * size * 0.5, y: my - uy * size * 0.5 };
  const r = (n: number) => Math.round(n * 100) / 100;
  return `M${r(back.x - uy * size * 0.6)} ${r(back.y + ux * size * 0.6)} L${r(tip.x)} ${r(tip.y)} L${r(back.x + uy * size * 0.6)} ${r(back.y - ux * size * 0.6)}`;
}
