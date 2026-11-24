/**
 * Phase 5: the ride state survives restarts, and a commit is either saved and published in full or not
 * at all. Everything runs through the real Fastify routes, the real engine and real SQLite files in a
 * temporary folder. "Restart" means closing the app and its database and opening a NEW store and app
 * on the same file; the last block uses separate Node processes running server/index.ts.
 *
 * Write failures are real SQLite failures: a test trigger added to the database file makes a chosen
 * statement abort inside the commit transaction. No database call is mocked.
 *
 * Line campus: a - b - c - d - e, 100 m paths, 10 s per path for these carts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { io as connectClient, type Socket } from "socket.io-client";
import { AnalyticsResponse } from "../shared/analytics";
import { StateSnapshot, StateUpdate } from "../shared/schemas";
import { SETTINGS } from "../shared/settings";
import { SNAPSHOT_EVENT, SNAPSHOT_REQUEST_EVENT, UPDATE_EVENT } from "../shared/realtime";
import { createFleet, type Fleet } from "../engine/fleet";
import { checkRideInvariants, createRequest, type RideState } from "../engine/rides";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { PersistenceError } from "./persistence";
import { openAppStore, type AppStore } from "./state";

const campus = lineCampus();
const dirs: string[] = [];
const running: { app: FastifyInstance; store: AppStore }[] = [];
const sockets: Socket[] = [];

async function stopAll() {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const r of running.splice(0)) {
    await r.app.close();
    r.store.close();
  }
}
afterEach(async () => {
  await stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeeny-persist-test-"));
  dirs.push(dir);
  return join(dir, "rides.sqlite");
}

function lineFleet(): Fleet {
  const f = createFleet(campus, [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
  if (!f.ok) throw new Error(f.errors.map((e) => e.message).join("; "));
  return f.fleet;
}

/** Start a server instance (store + app) on a database file, the way server/index.ts does. */
async function start(file: string) {
  const { store, created, revision } = openAppStore({ campus, databaseFile: file, loadSeedFleet: lineFleet, seededFrom: "test fleet" });
  const app = await buildApp({ store });
  running.push({ app, store });
  return { app, store, created, revision };
}
/** Close the running instance(s) and start a new one on the same file. */
async function restart(file: string) {
  await stopAll();
  return start(file);
}

const post = (app: FastifyInstance, url: string, payload?: object) => app.inject({ method: "POST", url, ...(payload ? { payload } : {}) });
const snapshot = async (app: FastifyInstance): Promise<StateSnapshot> => StateSnapshot.parse((await app.inject("/api/snapshot")).json());
/** Phase 5 Prompt 3: GET /api/analytics from a running instance, validated against the shared schema. */
async function analyticsOf(app: FastifyInstance): Promise<AnalyticsResponse> {
  const res = await app.inject("/api/analytics");
  expect(res.statusCode, res.body).toBe(200);
  return AnalyticsResponse.parse(res.json());
}
async function create(app: FastifyInstance, studentId: string, pickupId: string, destinationId: string, mode?: "shared") {
  const res = await post(app, "/api/ride-requests", { studentId, pickupId, destinationId, ...(mode ? { mode } : {}) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}
async function act(app: FastifyInstance, id: string, action: string, payload?: object) {
  const res = await post(app, `/api/ride-requests/${id}/${action}`, payload);
  expect(res.statusCode, `${action} ${id}: ${res.body}`).toBe(200);
  return res.json();
}
async function advanceBy(app: FastifyInstance, seconds: number) {
  const res = await post(app, "/api/simulation/advance", { seconds });
  expect(res.statusCode, res.body).toBe(200);
}
const tapBody = (studentId: string, pointId: string) => ({ studentId, campusId: "line", pointId });

function storedState(store: AppStore): RideState {
  let seen: RideState | undefined;
  store.apply((s) => { seen = s; return { ok: false as const, error: { code: "PEEK", message: "read only" } }; });
  return seen!;
}

/** Inspect or change a CLOSED database file directly (tests only). */
function rawDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}
const rows = (file: string, sql: string) => rawDb(file, (db) => db.prepare(sql).all());

const INTERNAL = { error: "Internal server error", code: "INTERNAL_ERROR" };

// ---------- Recovery ----------

describe("restart recovery", () => {
  it("every step of a Ghost Ride with Tap-In survives a restart exactly, including revision, clock and counters", async () => {
    const file = tempDb();
    let { app } = await start(file);
    let expected = await snapshot(app);
    expect(expected.revision).toBe(0);
    let expectedAnalytics = await analyticsOf(app);

    // After each step: restart, and the new instance must serve the identical snapshot.
    // Phase 5 Prompt 3: and the identical analytics, computed by the restored instance.
    const step = async (what: string, run: (a: FastifyInstance) => Promise<unknown>) => {
      await run(app);
      expected = await snapshot(app);
      expectedAnalytics = await analyticsOf(app);
      ({ app } = await restart(file));
      expect(await snapshot(app), `after restart: ${what}`).toEqual(expected);
      expect(await analyticsOf(app), `analytics after restart: ${what}`).toEqual(expectedAnalytics);
    };

    let lina = "", omar = "", sara = "";
    await step("shared request", async (a) => { lina = (await create(a, "stu-lina", "b", "d", "shared")).id; });
    await step("dispatch to a new cart", async (a) => act(a, lina, "dispatch"));
    await step("second shared request", async (a) => { omar = (await create(a, "stu-omar", "c", "e", "shared")).id; });
    await step("join the open trip", async (a) => {
      expect((await act(a, omar, "dispatch")).selection).toMatchObject({ outcome: "joined" });
    });
    await step("Lina taps in at her pickup", async (a) => {
      expect((await act(a, lina, "tap-in", tapBody("stu-lina", "b"))).alreadyRecorded).toBe(false);
    });
    await step("solo request", async (a) => { sara = (await create(a, "stu-sara", "a", "c")).id; });
    await step("solo dispatch", async (a) => act(a, sara, "dispatch"));
    await step("start the shared trip", async (a) => act(a, lina, "start"));
    await step("advance part way along a path", async (a) => advanceBy(a, 5));
    await step("advance to the first pickup", async (a) => advanceBy(a, 5));
    await step("board Lina", async (a) => act(a, lina, "board"));
    await step("Omar taps in", async (a) => act(a, omar, "tap-in", tapBody("stu-omar", "c")));
    await step("cancel the solo ride", async (a) => act(a, sara, "cancel"));
    await step("advance to Omar's pickup", async (a) => advanceBy(a, 10));
    await step("board Omar", async (a) => act(a, omar, "board"));
    await step("advance to Lina's stop", async (a) => advanceBy(a, 10));
    await step("drop off Lina (the trip carries on for Omar)", async (a) => act(a, lina, "drop-off"));

    const final = await snapshot(app);
    const trip = final.trips.find((t) => t.passengers.some((p) => p.requestId === omar))!;
    // Per-rider lifecycle on one shared trip, restored from SQLite.
    expect(trip.passengers.map((p) => ({ id: p.requestId, boarded: p.boarded, droppedOff: p.droppedOff, tapped: p.tappedIn?.locationId }))).toEqual([
      { id: lina, boarded: true, droppedOff: true, tapped: "b" },
      { id: omar, boarded: true, droppedOff: false, tapped: "c" },
    ]);
    expect(trip.status).toBe("active");
    expect(final.requests.map((r) => [r.id, r.status])).toEqual([[lina, "completed"], [omar, "on_board"], [sara, "cancelled"]]);
    expect(final.revision).toBe(17);
    expect(final.clockSeconds).toBe(30);
    expect(checkRideInvariants(storedState(running[0]!.store))).toEqual([]);

    // Phase 5 Prompt 3: analytics from the restored instance, checked against the scenario itself.
    // Lina created 0 s, tapped in 0 s (her cart was already dispatched), boarded 10 s, completed 30 s.
    // Omar created 0 s, tapped in 10 s. Sara created 0 s, cancelled 10 s.
    const a = await analyticsOf(app);
    expect(a.revision).toBe(17);
    expect(a.clock).toEqual({ basis: "simulated", nowSeconds: 30 });
    expect(a.demand).toMatchObject({
      totalRequests: 3, activeRequests: 1, finishedRequests: 2, requestsByMode: { solo: 1, shared: 2 },
      totalTrips: 2, tripsWithTwoOrMoreRiders: 1, totalRiders: 3, droppedOffRiders: 1, cancelledRiders: 1,
    });
    expect(a.demand.requestsByStatus).toMatchObject({ completed: 1, on_board: 1, cancelled: 1 });
    // Tap-In stays separate from boarding: two Tap-In records, boarding unavailable (not saved).
    expect(a.waiting.requestToTapIn).toEqual({ status: "available", measuredRequests: 2, meanSeconds: 5, medianSeconds: 5, maxSeconds: 10 });
    expect(a.waiting.requestToBoarding.status).toBe("unavailable");
    expect(a.waiting.requestToDropOff).toEqual({ status: "available", measuredRequests: 1, meanSeconds: 30, medianSeconds: 30, maxSeconds: 30 });
    expect(a.waiting.currentElapsedWait.measuredRequests).toBe(0);
    expect(a.cancellations).toMatchObject({ cancelledRequests: 1, finishedRequests: 2, shareOfFinished: 0.5 });
    expect(JSON.stringify(a)).not.toMatch(/stu-/);

    // The restored instance keeps going: new ids follow the saved counters, revisions continue.
    const next = await create(app, "stu-lina", "a", "b");
    expect(next.id).toBe("REQ-0004");
    expect((await snapshot(app)).revision).toBe(18);
  });

  it("fares and the loyalty flag are restored as saved (the same simulated fare for solo and shared)", async () => {
    const file = tempDb();
    let { app } = await start(file);
    await create(app, "stu-lina", "a", "b");
    await create(app, "stu-omar", "b", "c", "shared");
    ({ app } = await restart(file));
    expect((await snapshot(app)).requests.map((r) => ({ fare: r.fareJod, free: r.freeLoyaltyRide, mode: r.mode }))).toEqual([
      { fare: SETTINGS.fareJod, free: false, mode: "solo" },
      { fare: SETTINGS.sharedFareJod, free: false, mode: "shared" },
    ]);
  });

  it("Tap-In keeps its original location and time after a restart, and a replay still writes nothing", async () => {
    const file = tempDb();
    let { app } = await start(file);
    const lina = (await create(app, "stu-lina", "b", "d")).id;
    await act(app, lina, "dispatch");
    await act(app, lina, "start");
    await advanceBy(app, 4); // the clock moves before the tap
    const first = await act(app, lina, "tap-in", tapBody("stu-lina", "b"));
    expect(first.tapIn).toEqual({ requestId: lina, locationId: "b", atMs: 4000 });
    await advanceBy(app, 3); // and after it

    ({ app } = await restart(file));
    const before = await snapshot(app);
    const replay = await act(app, lina, "tap-in", tapBody("stu-lina", "b"));
    expect(replay).toMatchObject({ alreadyRecorded: true, tapIn: { requestId: lina, locationId: "b", atMs: 4000 } });
    expect(await snapshot(app)).toEqual(before); // no new revision
    // Phase 5 Prompt 3: the restored instance measures the saved Tap-In time (4 s after the 0 s request),
    // not the restart time and not the replay, and boarding (never happened) is not inferred from it.
    const restored = await analyticsOf(app);
    expect(restored.revision).toBe(before.revision);
    expect(restored.clock.nowSeconds).toBe(7);
    expect(restored.waiting.requestToTapIn).toEqual({ status: "available", measuredRequests: 1, meanSeconds: 4, medianSeconds: 4, maxSeconds: 4 });
    expect(restored.waiting.requestToBoarding.status).toBe("unavailable");
    expect(restored.demand.requestsByStatus).toMatchObject({ arriving: 1 });
    expect(restored.waiting.currentElapsedWait).toMatchObject({ measuredRequests: 1, maxSeconds: 7 });
    // A different point is still a mismatch against the saved record.
    const wrong = await post(app, `/api/ride-requests/${lina}/tap-in`, tapBody("stu-lina", "c"));
    expect(wrong.json().code).toBe("PICKUP_MISMATCH");
    await stopAll();
    expect(rows(file, "SELECT tapped_in_location_id AS loc, tapped_in_at_ms AS at FROM trip_passengers")).toEqual([{ loc: "b", at: 4000 }]);
  });

  it("a restarted server's realtime snapshot carries the saved revision, and updates continue from it", async () => {
    const file = tempDb();
    let { app } = await start(file);
    await create(app, "stu-lina", "a", "b");
    await create(app, "stu-omar", "b", "c");
    ({ app } = await restart(file));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const client = await connect(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`);
    expect(client.snapshot.revision).toBe(2);
    expect(client.snapshot.requests.map((r) => r.id)).toEqual(["REQ-0001", "REQ-0002"]);
    await create(app, "stu-sara", "c", "d");
    const synced = await client.sync();
    expect(client.updates.map((u) => [u.revision, u.operation])).toEqual([[3, "ride_request.created"]]);
    expect(synced.revision).toBe(3);
  });
});

// ---------- Failed writes ----------

/** Make one statement of every later commit fail inside SQLite, then (on the next start) work again. */
const failOn = (file: string, trigger: string) => rawDb(file, (db) => db.exec(`CREATE TRIGGER test_fail ${trigger} BEGIN SELECT RAISE(ABORT, 'injected test failure'); END`));
const healDb = (file: string) => rawDb(file, (db) => db.exec("DROP TRIGGER test_fail"));

interface Client { snapshot: StateSnapshot; updates: StateUpdate[]; sync(): Promise<StateSnapshot> }
async function connect(url: string): Promise<Client> {
  const socket = connectClient(url, { transports: ["websocket"], forceNew: true, reconnection: false, autoConnect: false });
  sockets.push(socket);
  const updates: StateUpdate[] = [];
  socket.on(UPDATE_EVENT, (raw: unknown) => updates.push(StateUpdate.parse(raw)));
  const first = new Promise<StateSnapshot>((resolve) => socket.once(SNAPSHOT_EVENT, (raw: unknown) => resolve(StateSnapshot.parse(raw))));
  socket.connect();
  const snapshot = await first;
  return {
    snapshot, updates,
    // Round trip: once acknowledged, every update the server sent earlier has arrived.
    sync: () => new Promise<StateSnapshot>((resolve) => socket.timeout(2000).emit(SNAPSHOT_REQUEST_EVENT, (err: Error | null, raw: unknown) => {
      if (err) throw err;
      resolve(StateSnapshot.parse(raw));
    })),
  };
}

describe("a write that fails to save", () => {
  it("returns the generic 500, publishes nothing, and leaves memory and the database as they were", async () => {
    const file = tempDb();
    let { app } = await start(file);
    await create(app, "stu-lina", "a", "b"); // revision 1
    await stopAll();
    failOn(file, "BEFORE UPDATE ON app_state"); // the LAST statement of every commit
    let store: AppStore;
    ({ app, store } = await start(file));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const client = await connect(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`);
    const before = await snapshot(app);
    const beforeState = storedState(store);

    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const res = await post(app, "/api/ride-requests", { studentId: "stu-omar", pickupId: "b", destinationId: "c" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual(INTERNAL);
      expect(res.body).not.toMatch(/injected|sqlite|app_state/i);
    } finally {
      console.error = original;
    }
    expect(errors.length).toBe(1); // the details went to the server log only

    expect(storedState(store)).toBe(beforeState); // the very same state object: nothing swapped in
    expect(await snapshot(app)).toEqual(before);
    const synced = await client.sync();
    expect(client.updates).toEqual([]); // no realtime update for a write that did not commit
    expect(synced.revision).toBe(1);

    await stopAll();
    expect(rows(file, "SELECT id FROM ride_requests")).toEqual([{ id: "REQ-0001" }]);
    expect(rows(file, "SELECT revision, next_request_no FROM app_state")).toEqual([{ revision: 1, next_request_no: 2 }]);
    healDb(file);
    ({ app } = await start(file));
    // The failed request consumed nothing: the next one gets the next id and revision.
    expect((await create(app, "stu-omar", "b", "c")).id).toBe("REQ-0002");
    expect((await snapshot(app)).revision).toBe(2);
  });

  it("a multi-record dispatch (request, trip, rider, cart) rolls back completely when its last row fails", async () => {
    const file = tempDb();
    let { app } = await start(file);
    const lina = (await create(app, "stu-lina", "b", "d")).id;
    await stopAll();
    // Carts, requests and the trip are written before the passenger rows in the same transaction.
    failOn(file, "BEFORE INSERT ON trip_passengers");
    let store: AppStore;
    ({ app, store } = await start(file));
    const original = console.error;
    console.error = () => {};
    try {
      const res = await post(app, `/api/ride-requests/${lina}/dispatch`);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual(INTERNAL);
    } finally {
      console.error = original;
    }
    const mem = await snapshot(app);
    expect(mem.requests[0]!.status).toBe("requested");
    expect(mem.trips).toEqual([]);
    expect(mem.carts.map((c) => c.status)).toEqual(["idle", "idle"]);
    expect(checkRideInvariants(storedState(store))).toEqual([]);

    await stopAll();
    expect(rows(file, "SELECT status FROM ride_requests")).toEqual([{ status: "requested" }]);
    expect(rows(file, "SELECT count(*) AS n FROM trips")).toEqual([{ n: 0 }]);
    expect(rows(file, "SELECT id, status FROM carts ORDER BY id")).toEqual([{ id: "CART-01", status: "idle" }, { id: "CART-02", status: "idle" }]);
    expect(rows(file, "SELECT revision, next_trip_no FROM app_state")).toEqual([{ revision: 1, next_trip_no: 1 }]);

    healDb(file);
    ({ app } = await start(file));
    expect((await act(app, lina, "dispatch")).trip.id).toBe("TRIP-0001");
  });

  it("after the database is closed, writes throw and change nothing", async () => {
    const file = tempDb();
    const { store, app } = await start(file);
    await app.close();
    running.splice(0);
    store.close();
    const before = storedState(store);
    expect(() => store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "a", destinationId: "b" }), "ride_request.created")).toThrow(PersistenceError);
    expect(storedState(store)).toBe(before);
    expect(store.read((_s, rev) => rev)).toBe(0);
  });
});

// ---------- Concurrency ----------

describe("concurrent requests against the database", () => {
  it("25 simultaneous ride requests: 25 unique saved rows and 25 revisions", async () => {
    const file = tempDb();
    let { app } = await start(file);
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => post(app, "/api/ride-requests", { studentId: `stu-${i}`, pickupId: "a", destinationId: "b" })));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    ({ app } = await restart(file));
    const snap = await snapshot(app);
    expect(snap.revision).toBe(25);
    expect(new Set(snap.requests.map((r) => r.id)).size).toBe(25);
    expect(new Set(snap.requests.map((r) => r.studentId)).size).toBe(25);
  });

  it("simultaneous identical Tap-Ins write one record and one revision", async () => {
    const file = tempDb();
    let { app } = await start(file);
    const lina = (await create(app, "stu-lina", "b", "d")).id;
    await act(app, lina, "dispatch");
    const before = (await snapshot(app)).revision;
    const results = await Promise.all(Array.from({ length: 6 }, () => post(app, `/api/ride-requests/${lina}/tap-in`, tapBody("stu-lina", "b"))));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(results.filter((r) => r.json().alreadyRecorded === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().tapIn.atMs)).size).toBe(1);
    ({ app } = await restart(file));
    expect((await snapshot(app)).revision).toBe(before + 1);
    await stopAll();
    expect(rows(file, "SELECT count(*) AS n FROM trip_passengers WHERE tapped_in_location_id IS NOT NULL")).toEqual([{ n: 1 }]);
  });

  it("simultaneous dispatches of one request create exactly one trip", async () => {
    const file = tempDb();
    const { app } = await start(file);
    const lina = (await create(app, "stu-lina", "b", "d")).id;
    const results = await Promise.all([1, 2, 3].map(() => post(app, `/api/ride-requests/${lina}/dispatch`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    await stopAll();
    expect(rows(file, "SELECT id, cart_id FROM trips")).toEqual([{ id: "TRIP-0001", cart_id: "CART-01" }]);
    expect(rows(file, "SELECT request_id FROM trip_passengers")).toEqual([{ request_id: lina }]);
  });
});

// ---------- Separate processes ----------

const REPO = process.cwd();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

interface ServerProcess { proc: ChildProcess; output: () => string; exited: Promise<number | null> }
/** Run the real server entry point (dev API mode, default Wadi Cedar campus) in its own Node process. */
function runServer(dbFile: string, port: number): ServerProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", "server/index.ts", `--db=${dbFile}`], {
    cwd: REPO, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => { out += d; });
  proc.stderr!.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  return { proc, output: () => out, exited };
}
async function waitFor(server: ServerProcess, text: string, ms = 20000) {
  const until = Date.now() + ms;
  while (!server.output().includes(text)) {
    if (Date.now() > until) throw new Error(`Timed out waiting for "${text}". Output:\n${server.output()}`);
    if (server.proc.exitCode !== null) throw new Error(`Server exited early (${server.proc.exitCode}). Output:\n${server.output()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("separate server processes (server/index.ts)", () => {
  it("state written by one process is served unchanged by the next one after a graceful stop", async () => {
    const file = tempDb();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const call = async (method: string, path: string, body?: object) => {
      const res = await fetch(base + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };

    const first = runServer(file, port);
    await waitFor(first, "Tap-In links");
    expect(first.output()).toMatch(/Database: .*rides\.sqlite \(new, seeded from campus\/fleets\/wadi-cedar\.json\)/);
    const created = await call("POST", "/api/ride-requests", { studentId: "stu-lina", pickupId: "pickup-main-plaza", destinationId: "library", mode: "shared" });
    expect(created.status).toBe(201);
    expect((await call("POST", `/api/ride-requests/${created.json.id}/dispatch`, {})).status).toBe(200);
    expect((await call("POST", `/api/ride-requests/${created.json.id}/tap-in`, { studentId: "stu-lina", campusId: "wadi-cedar", pointId: "pickup-main-plaza" })).status).toBe(200);
    expect((await call("POST", "/api/simulation/advance", { seconds: 30 })).status).toBe(200);
    const before = (await call("GET", "/api/snapshot")).json;
    expect(before.revision).toBe(4);

    first.proc.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    expect(first.output()).toContain("database closed");

    const second = runServer(file, port);
    try {
      await waitFor(second, "Tap-In links");
      expect(second.output()).toMatch(/\(restored at revision 4\)/);
      expect((await call("GET", "/api/snapshot")).json).toEqual(before);
    } finally {
      second.proc.kill("SIGTERM");
      await second.exited;
    }
  }, 60000);

  it("a database the server cannot trust stops startup: exit code 1, a clear reason, no listening, the file untouched", async () => {
    const file = tempDb();
    rawDb(file, (db) => db.exec("CREATE TABLE t (x); PRAGMA user_version = 7"));
    const bytes = readFileSync(file);
    const port = await freePort();
    const server = runServer(file, port);
    expect(await server.exited).toBe(1);
    expect(server.output()).toContain("The server did not start: Database schema version 7 is newer than this server supports");
    expect(server.output()).not.toContain("server ready");
    expect(readFileSync(file).equals(bytes)).toBe(true);
  }, 30000);
});
