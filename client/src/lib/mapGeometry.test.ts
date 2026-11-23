import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CampusConfig } from "../../../shared/schemas";
import { labelSize, pathSegments } from "./mapGeometry";

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
});
