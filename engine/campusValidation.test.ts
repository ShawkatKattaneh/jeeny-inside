import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { CampusConfig, type CampusConfigInput } from "../shared/schemas";
import { checkCampus } from "./campusValidation";

const load = (f: string) => CampusConfig.parse(JSON.parse(readFileSync(`campus/${f}`, "utf8")));

/** Four stops in a line, 100 map units apart, 115 m per path (the seeded campuses' ~1.15 m/unit). */
const line = (over: Partial<CampusConfigInput> = {}): CampusConfig =>
  CampusConfig.parse({
    id: "t", name: "T", fictional: true, map: { width: 400, height: 100 },
    locations: ["a", "b", "c", "d"].map((id, i) => ({ id, name: id, type: "pickup", position: { x: 50 + i * 100, y: 50 }, canStop: true })),
    paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 115, speedKmh: 12 },
      { id: "bc", from: "b", to: "c", lengthMeters: 115, speedKmh: 12 },
      { id: "cd", from: "c", to: "d", lengthMeters: 115, speedKmh: 12 },
    ],
    ...over,
  });

describe("checkCampus", () => {
  it.each(readdirSync("campus").filter((f) => f.endsWith(".json")))("%s has no errors and no warnings", (f) => {
    const r = checkCampus(load(f));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("reports the seeded campuses' scale (about 1.15 m per map unit) without changing their data", () => {
    for (const f of ["fictional-campus.json", "demo-valley.json"]) {
      const before = JSON.stringify(load(f));
      const r = checkCampus(load(f));
      expect(r.metersPerMapUnit).toBeGreaterThan(1.1);
      expect(r.metersPerMapUnit).toBeLessThan(1.2);
      expect(JSON.stringify(load(f))).toBe(before);
    }
  });

  it("a valid connected campus passes", () => {
    expect(checkCampus(line())).toMatchObject({ errors: [], warnings: [] });
  });

  it("rejects separate sections and names them", () => {
    const r = checkCampus(line({ paths: [{ id: "ab", from: "a", to: "b", lengthMeters: 115, speedKmh: 12 }, { id: "cd", from: "c", to: "d", lengthMeters: 115, speedKmh: 12 }] }));
    expect(r.errors.join("\n")).toContain("split into 2 separate sections");
    expect(r.errors.join("\n")).toContain("[a, b] / [c, d]");
    expect(r.errors.join("\n")).toContain('From "a", no cart can reach: c, d');
  });

  it("rejects a one-way dead end that a single-start check would miss (M1)", () => {
    const r = checkCampus(line({ paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 115, speedKmh: 12 },
      { id: "bc", from: "b", to: "c", lengthMeters: 115, speedKmh: 12 },
      { id: "cd", from: "c", to: "d", lengthMeters: 115, speedKmh: 12, oneWay: true },
    ] }));
    expect(r.connectivity.weaklyConnected).toBe(true);
    expect(r.connectivity.stronglyConnected).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('No cart can drive back to "a" from: d');
  });

  it("rejects a location that can be left but never reached by a one-way path", () => {
    const r = checkCampus(line({ paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 115, speedKmh: 12, oneWay: true },
      { id: "bc", from: "b", to: "c", lengthMeters: 115, speedKmh: 12 },
      { id: "cd", from: "c", to: "d", lengthMeters: 115, speedKmh: 12 },
    ] }));
    // Reference is the first id, "a": every stop is reachable from a, but nothing can get back to it.
    expect(r.errors).toEqual(['No cart can drive back to "a" from: b, c, d. A cart going there would be stranded; check one-way paths.']);
  });

  it("uses the depot as the reference location when there is one", () => {
    const c = line({ paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 115, speedKmh: 12, oneWay: true },
      { id: "bc", from: "b", to: "c", lengthMeters: 115, speedKmh: 12 },
      { id: "cd", from: "c", to: "d", lengthMeters: 115, speedKmh: 12 },
    ] });
    c.locations[3]!.type = "depot";
    expect(checkCampus(c).errors).toEqual(['From "d", no cart can reach: a. Add a path, or check the direction of one-way paths.']);
  });

  it("accepts one-way paths when every stop can still reach every other (a one-way loop)", () => {
    const r = checkCampus(line({ paths: [
      { id: "ab", from: "a", to: "b", lengthMeters: 115, speedKmh: 12, oneWay: true },
      { id: "bc", from: "b", to: "c", lengthMeters: 115, speedKmh: 12, oneWay: true },
      { id: "cd", from: "c", to: "d", lengthMeters: 115, speedKmh: 12, oneWay: true },
      { id: "da", from: "d", to: "a", lengthMeters: 345, speedKmh: 12, oneWay: true },
    ] }));
    expect(r.errors).toEqual([]);
    expect(r.connectivity.oneWayPathIds).toEqual(["ab", "bc", "cd", "da"]);
  });

  describe("warnings (suspicious but allowed)", () => {
    it("a path much shorter than its map distance", () => {
      const c = line();
      c.paths[1]!.lengthMeters = 40;
      const r = checkCampus(c);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual(['Path "bc" is 40 m, but its ends are about 115 m apart on the map at this campus\'s scale. Check the length or the coordinates.']);
    });

    it("a path much longer than its map distance", () => {
      const c = line();
      c.paths[2]!.lengthMeters = 400;
      expect(checkCampus(c).warnings).toEqual(['Path "cd" is 400 m, more than 2x the ~115 m its ends are apart on the map. Fine if it winds; otherwise check it.']);
    });

    it("does not judge lengths when there are too few paths to know the scale", () => {
      const c = line({
        locations: line().locations.slice(0, 3),
        paths: [{ id: "ab", from: "a", to: "b", lengthMeters: 5, speedKmh: 12 }, { id: "bc", from: "b", to: "c", lengthMeters: 900, speedKmh: 12 }],
      });
      expect(checkCampus(c).metersPerMapUnit).not.toBeNull();
      expect(checkCampus(c).warnings).toEqual([]);
    });

    it("a location outside the map", () => {
      const c = line();
      c.locations[3]!.position = { x: 450, y: 50 };
      c.paths[2]!.lengthMeters = 230;
      expect(checkCampus(c).warnings).toEqual(['Location "d" at (450, 50) is outside the 400x100 map and will be drawn off-screen.']);
    });

    it("two locations at the same spot", () => {
      const c = line({ paths: [...line().paths, { id: "bd", from: "b", to: "d", lengthMeters: 230, speedKmh: 12 }] });
      c.locations[0]!.position = { x: 150, y: 50 };
      const w = checkCampus(c).warnings;
      expect(w).toContain('Locations "a", "b" share the same map position (150,50); their markers will overlap.');
    });

    it("duplicate connections between the same two locations", () => {
      const c = line({ paths: [...line().paths, { id: "ba", from: "b", to: "a", lengthMeters: 115, speedKmh: 12 }] });
      const r = checkCampus(c);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual(['Paths "ab", "ba" all connect a <-> b. Routing uses the shortest; remove duplicates unless they are really separate roads.']);
    });
  });
});
