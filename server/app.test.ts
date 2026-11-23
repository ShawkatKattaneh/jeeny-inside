import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadCampus } from "./campus";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("server", () => {
  it("serves health, campus and personas", async () => {
    app = await buildApp({ campus: loadCampus() });
    expect((await app.inject("/api/health")).json()).toMatchObject({ ok: true, campus: "wadi-cedar" });
    const campus = (await app.inject("/api/campus")).json();
    expect(campus.locations).toHaveLength(15);
    const personas = (await app.inject("/api/personas")).json();
    expect(personas.length).toBeGreaterThanOrEqual(3);
    expect((await app.inject("/api/nope")).statusCode).toBe(404);
  });

  it("swapping the campus file changes the map the app receives", async () => {
    app = await buildApp({ campus: loadCampus("campus/demo-valley.json") });
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
});
