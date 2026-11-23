import type { CampusConfig, LocationType } from "../../../shared/schemas";

export interface Segment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Turn campus paths into drawable line segments. Pure, so it is tested without a browser. */
export function pathSegments(campus: CampusConfig): Segment[] {
  const pos = new Map(campus.locations.map((l) => [l.id, l.position]));
  return campus.paths.flatMap((p) => {
    const a = pos.get(p.from);
    const b = pos.get(p.to);
    return a && b ? [{ id: p.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y }] : [];
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
