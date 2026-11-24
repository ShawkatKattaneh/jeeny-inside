import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadCampus } from "./campus";
import { loadFleet } from "./fleet";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("server", () => {
  it("serves health, campus and personas", async () => {
    const loaded = loadCampus();
    app = await buildApp({ campus: loaded, fleet: loadFleet(loaded) });
    expect((await app.inject("/api/health")).json()).toMatchObject({ ok: true, campus: "wadi-cedar" });
    const campus = (await app.inject("/api/campus")).json();
    expect(campus.locations).toHaveLength(15);
    const personas = (await app.inject("/api/personas")).json();
    expect(personas.length).toBeGreaterThanOrEqual(3);
    expect((await app.inject("/api/nope")).statusCode).toBe(404);
  });

  it("swapping the campus file changes the map the app receives", async () => {
    const loaded = loadCampus("campus/demo-valley.json");
    app = await buildApp({ campus: loaded, fleet: loadFleet(loaded) });
    const campus = (await app.inject("/api/campus")).json();
    expect(campus.id).toBe("demo-valley");
    expect(campus.locations).toHaveLength(6);
  });

  it("CAMPUS_FILE picks the campus", () => {
    const prev = process.env.CAMPUS_FILE;
    process.env.CAMPUS_FILE = "campus/demo-valley.json";
    try {
      expect(loadCampus().id).toBe("demo-valley");
    } finally {
      if (prev === undefined) delete process.env.CAMPUS_FILE;
      else process.env.CAMPUS_FILE = prev;
    }
  });

  it("refuses a broken campus file with a readable message", () => {
    const dir = mkdtempSync(join(tmpdir(), "campus-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ id: "x", name: "X", fictional: true, map: { width: 10, height: 10 }, locations: [], paths: [] }));
    expect(() => loadCampus(bad)).toThrow(/is invalid/);
    const cut = join(dir, "cut.json");
    writeFileSync(cut, JSON.stringify({
      id: "x", name: "X", fictional: true, map: { width: 10, height: 10 },
      locations: ["a", "b", "c"].map((id) => ({ id, name: id, type: "pickup", position: { x: 1, y: 1 }, canStop: true })),
      paths: [{ id: "ab", from: "a", to: "b", lengthMeters: 5, speedKmh: 10 }],
    }));
    expect(() => loadCampus(cut)).toThrow(/no cart can reach: c/);
  });

  const writeCampus = (name: string, c: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "campus-"));
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(c));
    return file;
  };
  const stops = (ids: string[]) => ids.map((id, i) => ({ id, name: id, type: "pickup", position: { x: 1 + i * 2, y: 1 }, canStop: true }));

  it("refuses a campus with a one-way dead end, even though everything is reachable from the first location", () => {
    const trap = writeCampus("trap.json", {
      id: "x", name: "X", fictional: true, map: { width: 10, height: 10 },
      locations: stops(["a", "b", "c"]),
      paths: [
        { id: "ab", from: "a", to: "b", lengthMeters: 5, speedKmh: 10 },
        { id: "bc", from: "b", to: "c", lengthMeters: 5, speedKmh: 10, oneWay: true },
      ],
    });
    expect(() => loadCampus(trap)).toThrow(/No cart can drive back to "a" from: c/);
  });

  it("loads a campus with suspicious data but prints a warning for each issue", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const odd = writeCampus("odd.json", {
        id: "odd", name: "Odd", fictional: true, map: { width: 10, height: 10 },
        locations: stops(["a", "b", "c", "d"]).map((l, i) => (i === 3 ? { ...l, position: { x: 50, y: 1 } } : l)),
        paths: [
          { id: "ab", from: "a", to: "b", lengthMeters: 2, speedKmh: 10 },
          { id: "bc", from: "b", to: "c", lengthMeters: 2, speedKmh: 10 },
          { id: "cd", from: "c", to: "d", lengthMeters: 45, speedKmh: 10 },
        ],
      });
      expect(loadCampus(odd).id).toBe("odd");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/Location "d" at \(50, 1\) is outside the 10x10 map/);
    } finally {
      warn.mockRestore();
    }
  });

  it("the seeded campuses load without warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadCampus();
      loadCampus("campus/demo-valley.json");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("the campus API response keeps its Phase 0 shape after the swap", async () => {
    for (const file of [undefined, "campus/demo-valley.json"]) {
      const loaded = loadCampus(file);
      app = await buildApp({ campus: loaded, fleet: loadFleet(loaded) });
      const body = (await app.inject("/api/campus")).json();
      expect(Object.keys(body).sort()).toEqual(["description", "fictional", "id", "locations", "map", "name", "paths"]);
      expect(body.paths.every((p: { oneWay: unknown }) => typeof p.oneWay === "boolean")).toBe(true);
      await app.close();
      app = undefined;
    }
  });
});
