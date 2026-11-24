/**
 * Phase 5 Prompt 2: GET /api/analytics through the real Fastify app, on a real SQLite file in a temp
 * folder. Checks the response contract, query validation, and the read-only boundary: no database
 * change, no revision change, no realtime update, no store write.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { io as connectClient, type Socket } from "socket.io-client";
import { AnalyticsResponse } from "../shared/analytics";
import { StateSnapshot, StateUpdate } from "../shared/schemas";
import { SNAPSHOT_EVENT, SNAPSHOT_REQUEST_EVENT, UPDATE_EVENT } from "../shared/realtime";
import { computeAnalytics } from "../engine/analytics";
import { createFleet } from "../engine/fleet";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { openAppStore, type AppStore } from "./state";

const campus = lineCampus();
const dirs: string[] = [];
const running: { app: FastifyInstance; store: AppStore }[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const r of running.splice(0)) { await r.app.close(); r.store.close(); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(wrap: (store: AppStore) => AppStore = (s) => s) {
  const dir = mkdtempSync(join(tmpdir(), "jeeny-analytics-test-"));
  dirs.push(dir);
  const file = join(dir, "rides.sqlite");
  const fleet = createFleet(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e"), cartAt("CART-03", "c", { status: "charging" })]);
  if (!fleet.ok) throw new Error("fixture");
  const { store } = openAppStore({ campus, databaseFile: file, loadSeedFleet: () => fleet.fleet, seededFrom: "test" });
  const app = await buildApp({ store: wrap(store) });
  running.push({ app, store });
  return { app, store, file };
}

const post = (app: FastifyInstance, url: string, payload?: object) => app.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
async function populate(app: FastifyInstance) {
  const lina = (await post(app, "/api/ride-requests", { studentId: "stu-lina", pickupId: "b", destinationId: "d", mode: "shared" })).json().id;
  expect((await post(app, `/api/ride-requests/${lina}/dispatch`)).statusCode).toBe(200);
  const omar = (await post(app, "/api/ride-requests", { studentId: "stu-omar", pickupId: "c", destinationId: "e", mode: "shared" })).json().id;
  expect((await post(app, `/api/ride-requests/${omar}/dispatch`)).statusCode).toBe(200);
  expect((await post(app, `/api/ride-requests/${lina}/start`)).statusCode).toBe(200);
  expect((await post(app, "/api/simulation/advance", { seconds: 10 })).statusCode).toBe(200);
  expect((await post(app, `/api/ride-requests/${lina}/tap-in`, { studentId: "stu-lina", campusId: "line", pointId: "b" })).statusCode).toBe(200);
  const sara = (await post(app, "/api/ride-requests", { studentId: "stu-sara", pickupId: "a", destinationId: "b" })).json().id;
  expect((await post(app, `/api/ride-requests/${sara}/cancel`)).statusCode).toBe(200);
}

describe("GET /api/analytics", () => {
  it("returns the documented shape for an empty database", async () => {
    const { app } = await start();
    const res = await app.inject("/api/analytics");
    expect(res.statusCode).toBe(200);
    const a = AnalyticsResponse.parse(res.json());
    expect(a).toMatchObject({ revision: 0, campusId: "line", demand: { totalRequests: 0, totalTrips: 0 }, observations: [] });
    expect(a.fleet.cartsByStatus).toMatchObject({ idle: 2, charging: 1 });
  });

  it("matches the analytics computed from the same committed state, and keeps units apart", async () => {
    const { app, store } = await start();
    await populate(app);
    const a = AnalyticsResponse.parse((await app.inject("/api/analytics")).json());
    expect(a).toEqual(store.read((s, rev) => computeAnalytics(s, rev)));
    expect(a.revision).toBe(9); // 9 committed operations in populate()
    expect(a.demand).toMatchObject({ totalRequests: 3, totalTrips: 1, tripsWithTwoOrMoreRiders: 1, totalRiders: 2 });
    expect(a.waiting.requestToTapIn).toMatchObject({ measuredRequests: 1, meanSeconds: 10 });
    expect(a.cancellations).toMatchObject({ cancelledRequests: 1, finishedRequests: 1, shareOfFinished: 1 });
  });

  it("refuses any query parameter with the usual 400 INVALID_REQUEST body", async () => {
    const { app } = await start();
    for (const qs of ["window=today", "from=2026-01-01", "x="]) {
      const res = await app.inject(`/api/analytics?${qs}`);
      expect(res.statusCode, qs).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_REQUEST", error: expect.stringContaining("analytics query") });
    }
  });

  it("exposes no student ids", async () => {
    const { app } = await start();
    await populate(app);
    expect((await app.inject("/api/analytics")).body).not.toMatch(/stu-/);
  });
});

describe("read-only boundary", () => {
  it("does not change the database file, the revision or the state", async () => {
    const { app, file } = await start();
    await populate(app);
    const before = (await app.inject("/api/snapshot")).json();
    // The server holds the file exclusively; its committed bytes (main file + WAL) must not change.
    const bytes = () => Buffer.concat([readFileSync(file), (() => { try { return readFileSync(`${file}-wal`); } catch { return Buffer.alloc(0); } })()]);
    const fileBefore = bytes();
    for (let i = 0; i < 5; i++) expect((await app.inject("/api/analytics")).statusCode).toBe(200);
    expect(bytes().equals(fileBefore)).toBe(true);
    expect((await app.inject("/api/snapshot")).json()).toEqual(before);
    expect(StateSnapshot.parse((await app.inject("/api/snapshot")).json()).clockSeconds).toBe(before.clockSeconds); // Prompt 3: clock stated explicitly
    expect(before.clockSeconds).toBe(10);
    // The next real change still gets the next revision: analytics used none.
    const next = await post(app, "/api/ride-requests", { studentId: "stu-sara", pickupId: "a", destinationId: "c" });
    expect(next.statusCode).toBe(201);
    expect(StateSnapshot.parse((await app.inject("/api/snapshot")).json()).revision).toBe(before.revision + 1);
  });

  it("never calls the store's write path", async () => {
    const applies: string[] = [];
    const { app } = await start((store) => Object.freeze({ ...store, apply: ((op: unknown, operation?: string) => { applies.push(operation ?? "?"); return store.apply(op as never, operation as never); }) as AppStore["apply"] }));
    await populate(app);
    const writes = applies.length;
    for (let i = 0; i < 3; i++) expect((await app.inject("/api/analytics")).statusCode).toBe(200);
    expect(applies.length).toBe(writes);
  });

  it("sends no realtime update", async () => {
    const { app } = await start();
    await populate(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const socket = connectClient(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, { transports: ["websocket"], forceNew: true, reconnection: false, autoConnect: false });
    sockets.push(socket);
    const updates: StateUpdate[] = [];
    socket.on(UPDATE_EVENT, (raw: unknown) => updates.push(StateUpdate.parse(raw)));
    const first = new Promise<StateSnapshot>((resolve) => socket.once(SNAPSHOT_EVENT, (raw: unknown) => resolve(StateSnapshot.parse(raw))));
    socket.connect();
    const snap = await first;
    for (let i = 0; i < 3; i++) expect((await app.inject("/api/analytics")).statusCode).toBe(200);
    // Round trip: once acknowledged, anything the server sent earlier has arrived.
    const after = await new Promise<StateSnapshot>((resolve, reject) => socket.timeout(2000).emit(SNAPSHOT_REQUEST_EVENT, (err: Error | null, raw: unknown) => (err ? reject(err) : resolve(StateSnapshot.parse(raw)))));
    expect(updates).toEqual([]);
    expect(after.revision).toBe(snap.revision);
  });

  // Phase 5 Prompt 3: one check per path (valid on a populated database, valid on an empty database,
  // invalid filters), each covering every place a write could show up: the in-memory state object, the
  // SQLite bytes (main file + WAL), the revision, the simulated clock, the store's write path and
  // realtime events. Real store, real database file, real Socket.IO client; nothing is mocked.
  for (const path of ["valid request on a populated database", "valid request on an empty database", "invalid filters"] as const) {
    it(`leaves memory, SQLite, revision, clock and realtime untouched: ${path}`, async () => {
      const applies: string[] = [];
      const { app, store, file } = await start((s) => Object.freeze({ ...s, apply: ((op: unknown, operation?: string) => { applies.push(operation ?? "?"); return s.apply(op as never, operation as never); }) as AppStore["apply"] }));
      if (path !== "valid request on an empty database") await populate(app);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const socket = connectClient(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, { transports: ["websocket"], forceNew: true, reconnection: false, autoConnect: false });
      sockets.push(socket);
      const updates: unknown[] = [];
      socket.on(UPDATE_EVENT, (raw: unknown) => updates.push(raw));
      const first = new Promise<StateSnapshot>((resolve) => socket.once(SNAPSHOT_EVENT, (raw: unknown) => resolve(StateSnapshot.parse(raw))));
      socket.connect();
      await first;

      const bytes = () => Buffer.concat([readFileSync(file), (() => { try { return readFileSync(`${file}-wal`); } catch { return Buffer.alloc(0); } })()]);
      // The store's own state object (read gives the selector the live frozen object).
      const liveState = () => { let ref: unknown; store.read((s) => { ref = s; return 0; }); return ref; };
      const before = { state: liveState(), snapshot: StateSnapshot.parse((await app.inject("/api/snapshot")).json()), bytes: bytes(), applies: applies.length };
      expect(before.snapshot.clockSeconds).toBe(path === "valid request on an empty database" ? 0 : 10);

      const urls = path === "invalid filters" ? ["/api/analytics?window=today", "/api/analytics?from=2026-01-01&to=2026-02-01", "/api/analytics?x="] : ["/api/analytics", "/api/analytics", "/api/analytics"];
      for (const url of urls) {
        const res = await app.inject(url);
        expect(res.statusCode, url).toBe(path === "invalid filters" ? 400 : 200);
        if (path !== "invalid filters") expect(AnalyticsResponse.parse(res.json()).revision).toBe(before.snapshot.revision);
      }

      // Round trip over the socket: anything the server sent before the ack has arrived.
      const after = await new Promise<StateSnapshot>((resolve, reject) => socket.timeout(2000).emit(SNAPSHOT_REQUEST_EVENT, (err: Error | null, raw: unknown) => (err ? reject(err) : resolve(StateSnapshot.parse(raw)))));
      expect(updates).toEqual([]);
      expect(applies.length).toBe(before.applies);
      expect(liveState()).toBe(before.state); // the same object: memory was never swapped
      expect(bytes().equals(before.bytes)).toBe(true);
      expect(after).toEqual(before.snapshot);
      expect(after.revision).toBe(before.snapshot.revision);
      expect(after.clockSeconds).toBe(before.snapshot.clockSeconds);
      // Reading the persisted rows back through the next real write: the revision continues at +1 and the
      // clock has not moved, so analytics consumed neither.
      expect((await post(app, "/api/ride-requests", { studentId: "stu-sara", pickupId: "a", destinationId: "c" })).statusCode).toBe(201);
      const next = StateSnapshot.parse((await app.inject("/api/snapshot")).json());
      expect(next.revision).toBe(before.snapshot.revision + 1);
      expect(next.clockSeconds).toBe(before.snapshot.clockSeconds);
      expect(liveState()).not.toBe(before.state); // control: a real write does swap the object, so the identity check above can fail
      expect(bytes().equals(before.bytes)).toBe(false); // control: and does change the saved bytes
    });
  }
});
