/**
 * Final completion pass, against the real app on a temporary SQLite file: the driver's arrival endpoint,
 * the read-only ETA endpoint, server-driven simulated movement, and loyalty through the API.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { RideEtaResponse, StateSnapshot } from "../shared/schemas";
import { SETTINGS } from "../shared/settings";
import { createFleet, type Fleet } from "../engine/fleet";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { openAppStore, type AppStore } from "./state";

const campus = lineCampus();
const dirs: string[] = [];
const running: { app: FastifyInstance; store: AppStore }[] = [];
async function stopAll() { for (const r of running.splice(0)) { await r.app.close(); r.store.close(); } }
afterEach(async () => { await stopAll(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tempDb() { const dir = mkdtempSync(join(tmpdir(), "jeeny-final-test-")); dirs.push(dir); return join(dir, "rides.sqlite"); }
function lineFleet(): Fleet { const f = createFleet(campus, [cartAt("CART-01", "a")]); if (!f.ok) throw new Error("fleet"); return f.fleet; }
async function start(file: string) {
  const { store } = openAppStore({ campus, databaseFile: file, loadSeedFleet: lineFleet, seededFrom: "test fleet" });
  const app = await buildApp({ store });
  running.push({ app, store });
  return { app, store };
}
const post = (app: FastifyInstance, url: string, payload?: object) => app.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
const snapshot = async (app: FastifyInstance) => StateSnapshot.parse((await app.inject("/api/snapshot")).json());
async function ok(app: FastifyInstance, url: string, payload?: object) { const r = await post(app, url, payload); expect(r.statusCode, `${url}: ${r.body}`).toBe(200); return r.json(); }
async function bookAndAssign(app: FastifyInstance) {
  const r = await post(app, "/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d" });
  expect(r.statusCode, r.body).toBe(201);
  const id = (r.json() as { id: string }).id;
  const d = await ok(app, `/api/ride-requests/${id}/dispatch`);
  return { id, tripId: d.trip.id as string };
}

describe("POST /api/trips/:tripId/arrive", () => {
  it("is validated by the server, saved, and survives a restart; duplicates and early arrivals are refused", async () => {
    const file = tempDb();
    let { app } = await start(file);
    const { id, tripId } = await bookAndAssign(app);
    expect((await post(app, "/api/trips/TRIP-9999/arrive")).statusCode).toBe(404);
    expect((await post(app, `/api/trips/${tripId}/arrive`, { cartId: "CART-01" })).statusCode).toBe(400);
    expect((await post(app, `/api/trips/${tripId}/arrive`)).json()).toMatchObject({ code: "INVALID_TRANSITION" });
    await ok(app, `/api/ride-requests/${id}/start`);
    const early = await post(app, `/api/trips/${tripId}/arrive`);
    expect([early.statusCode, early.json().code]).toEqual([409, "NOT_AT_STOP"]);
    await ok(app, "/api/simulation/advance", { seconds: 60 });
    const rev = (await snapshot(app)).revision;
    const res = await ok(app, `/api/trips/${tripId}/arrive`);
    expect(res.trip.stops[0].arrivedAtMs).toBeTypeOf("number");
    expect((await snapshot(app)).revision).toBe(rev + 1);
    const dup = await post(app, `/api/trips/${tripId}/arrive`);
    expect([dup.statusCode, dup.json().code]).toEqual([409, "ALREADY_ARRIVED"]);
    expect((await snapshot(app)).revision).toBe(rev + 1); // a refused call creates no revision
    // The ride itself did not move: boarding is still the driver's separate action.
    expect((await snapshot(app)).requests[0]!.status).toBe("arriving");
    await stopAll();
    ({ app } = await start(file));
    expect((await snapshot(app)).trips[0]!.stops[0]!.arrivedAtMs).toBe(res.trip.stops[0].arrivedAtMs);
  });
});

describe("GET /api/ride-requests/:id/eta", () => {
  it("returns the engine's ETA and leg progress for a ride with a cart, and refuses rides without one", async () => {
    const { app } = await start(tempDb());
    const r = await post(app, "/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d" });
    const id = (r.json() as { id: string }).id;
    expect((await app.inject(`/api/ride-requests/${id}/eta`)).statusCode).toBe(409);
    await ok(app, `/api/ride-requests/${id}/dispatch`);
    const assigned = RideEtaResponse.parse((await app.inject(`/api/ride-requests/${id}/eta`)).json());
    expect(assigned.pickupSeconds).toBeGreaterThan(0);
    expect(assigned.legProgress).toBeNull();
    await ok(app, `/api/ride-requests/${id}/start`);
    await ok(app, "/api/simulation/advance", { seconds: 5 });
    const moving = RideEtaResponse.parse((await app.inject(`/api/ride-requests/${id}/eta`)).json());
    expect(moving.pickupSeconds!).toBeLessThan(assigned.pickupSeconds!);
    expect(moving.legProgress!).toBeGreaterThan(0);
    expect(moving.legProgress!).toBeLessThan(1);
    expect((await app.inject("/api/ride-requests/REQ-9999/eta")).statusCode).toBe(404);
  });
});

describe("server-driven simulated movement", () => {
  it("moves a driving cart through the same engine advance, once a second, only while running", async () => {
    const { app } = await start(tempDb());
    expect((await app.inject("/api/simulation/auto")).json()).toEqual({ running: false, speed: 1, tickMs: 1000 });
    expect((await post(app, "/api/simulation/auto", { running: true, speed: 3 })).statusCode).toBe(400);
    expect((await post(app, "/api/simulation/auto", { running: "yes" })).statusCode).toBe(400);
    const { id } = await bookAndAssign(app);
    await ok(app, `/api/ride-requests/${id}/start`);
    const before = await snapshot(app);
    expect(await ok(app, "/api/simulation/auto", { running: true, speed: 10 })).toEqual({ running: true, speed: 10, tickMs: 1000 });
    await new Promise((r) => setTimeout(r, 2300));
    const during = await snapshot(app);
    expect(during.clockSeconds).toBeGreaterThanOrEqual(before.clockSeconds + 20);
    expect(during.revision).toBeGreaterThan(before.revision);
    // Movement never boards anyone: the cart waits at the pickup for the driver.
    expect(during.requests[0]!.status).toBe("arriving");
    await ok(app, "/api/simulation/auto", { running: false });
    const stopped = await snapshot(app);
    await new Promise((r) => setTimeout(r, 1300));
    expect((await snapshot(app)).revision).toBe(stopped.revision);
  });

  it("creates no revision while nothing is driving", async () => {
    const { app } = await start(tempDb());
    const rev = (await snapshot(app)).revision;
    await ok(app, "/api/simulation/auto", { running: true, speed: 1 });
    await new Promise((r) => setTimeout(r, 1300));
    expect((await snapshot(app)).revision).toBe(rev);
    await ok(app, "/api/simulation/auto", { running: false });
  });
});

describe("loyalty through the API", () => {
  it(`after ${SETTINGS.loyaltyPaidRidesForFree} completed paid rides the next request is free (fare 0) and saved that way`, async () => {
    const { app } = await start(tempDb());
    for (let i = 0; i < SETTINGS.loyaltyPaidRidesForFree; i++) {
      const { id, tripId } = await bookAndAssign(app);
      await ok(app, `/api/ride-requests/${id}/start`);
      await ok(app, "/api/simulation/advance", { seconds: 600 });
      await ok(app, `/api/trips/${tripId}/arrive`);
      await ok(app, `/api/ride-requests/${id}/board`);
      await ok(app, "/api/simulation/advance", { seconds: 600 });
      await ok(app, `/api/trips/${tripId}/arrive`);
      await ok(app, `/api/ride-requests/${id}/drop-off`);
    }
    const r = await post(app, "/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d" });
    expect(r.json()).toMatchObject({ freeLoyaltyRide: true, fareJod: 0 });
  });
});

describe("POST /api/mission/run", () => {
  it("compares pooling on and off on a copy, validates its options, and never changes the live state", async () => {
    const { app } = await start(tempDb());
    const before = await snapshot(app);
    expect((await post(app, "/api/mission/run", { seed: 1.5 })).statusCode).toBe(400);
    expect((await post(app, "/api/mission/run", { requests: 2, extra: true })).statusCode).toBe(400);
    const r = await post(app, "/api/mission/run", { seed: 3, requests: 6 });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.results.map((x: { policy: string }) => x.policy)).toEqual(["pooling_on", "pooling_off"]);
    expect(body.demand).toHaveLength(6);
    const after = await snapshot(app);
    expect(after.revision).toBe(before.revision);
    expect(after.requests).toEqual([]);
  });
});
