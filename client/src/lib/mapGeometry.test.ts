import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { CampusConfig } from "../../../shared/schemas";
import { labelSize, oneWayArrow, pathSegments, type Segment } from "./mapGeometry";

const load = (f: string) => CampusConfig.parse(JSON.parse(readFileSync(f, "utf8")));

describe("map geometry", () => {
  it("draws one segment per campus path, from the config's own coordinates", () => {
    const campus = load("campus/fictional-campus.json");
    const segs = pathSegments(campus);
    expect(segs).toHaveLength(campus.paths.length);
    const first = campus.paths[0]!;
    const from = campus.locations.find((l) => l.id === first.from)!;
    expect(segs[0]).toMatchObject({ x1: from.position.x, y1: from.position.y });
  });

  it("a different campus file gives a different map", () => {
    const a = load("campus/fictional-campus.json");
    const b = load("campus/demo-valley.json");
    expect(pathSegments(a)).not.toEqual(pathSegments(b));
    expect(labelSize(a)).toBeGreaterThanOrEqual(12);
  });

  it.each(readdirSync("campus").filter((f) => f.endsWith(".json")))("%s: every path is drawn between its own two locations, inside the map", (f) => {
    const campus = load(`campus/${f}`);
    const pos = new Map(campus.locations.map((l) => [l.id, l.position]));
    const segs = pathSegments(campus);
    expect(segs.map((s) => s.id)).toEqual(campus.paths.map((p) => p.id));
    campus.paths.forEach((p, i) => {
      const s = segs[i]!;
      expect(s).toEqual({ id: p.id, x1: pos.get(p.from)!.x, y1: pos.get(p.from)!.y, x2: pos.get(p.to)!.x, y2: pos.get(p.to)!.y, oneWay: p.oneWay });
      for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]] as const) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(campus.map.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(campus.map.height);
      }
    });
  });

  it("marks one-way paths so the map can show their direction", () => {
    const campus = load("campus/demo-valley.json");
    const oneWay = { ...campus, paths: campus.paths.map((p, i) => (i === 0 ? { ...p, oneWay: true } : p)) };
    expect(pathSegments(oneWay).filter((s) => s.oneWay).map((s) => s.id)).toEqual([campus.paths[0]!.id]);
  });

  it("the one-way arrow sits at the middle and points from 'from' to 'to'", () => {
    const seg: Segment = { id: "s", x1: 0, y1: 0, x2: 100, y2: 0, oneWay: true };
    // Tip at x=55 (ahead of the middle), wings behind it at x=45.
    expect(oneWayArrow(seg, 10)).toBe("M45 6 L55 0 L45 -6");
    const back = oneWayArrow({ ...seg, x1: 100, x2: 0 }, 10)!;
    expect(back.split(" L")[1]).toBe("45 0");
    expect(oneWayArrow({ ...seg, x2: 0 }, 10)).toBeNull();
  });
});
