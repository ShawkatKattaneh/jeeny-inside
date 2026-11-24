/**
 * Phase 2 Prompt 3: realtime updates over a real Socket.IO server and client, on isolated app
 * instances listening on random local ports. State changes go through the real REST routes and the
 * real engine. No sleeps: every wait is an explicit event or acknowledgement with a bounded timeout.
 *
 * "Nothing else arrived" is checked with a round trip: Socket.IO delivers one socket's packets in
 * order, so once a snapshot request is acknowledged, every update the server sent before it has
 * already been received.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { io as connectClient, type Socket } from "socket.io-client";
import { StateSnapshot, StateUpdate, type CartInput } from "../shared/schemas";
import { SNAPSHOT_EVENT, SNAPSHOT_REQUEST_EVENT, UPDATE_EVENT, classifyRevision } from "../shared/realtime";
import { createFleet } from "../engine/fleet";
import { advance } from "../engine/simulation";
import { cartAt, lineCampus } from "../engine/testRideFixtures";
import { buildApp } from "./app";
import { createAppStore, type AppStore } from "./state";

const TIMEOUT_MS = 2000;
const apps: FastifyInstance[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

interface Live { app: FastifyInstance; store: AppStore; url: string }

/** A listening app on the line campus (a - b - c - d - e, 10 s per path for these carts). */
async function liveApp(carts: CartInput[] = [cartAt("CART-01", "a")]): Promise<Live> {
  const campus = lineCampus();
  const fleet = createFleet(campus, carts);
  if (!fleet.ok) throw new Error(fleet.errors.map((e) => e.message).join("; "));
  const store = createAppStore(campus, fleet.fleet);
  const app = await buildApp({ store });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, store, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), TIMEOUT_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

interface Client {
  socket: Socket;
  /** The snapshot sent on connection. */
  snapshot: StateSnapshot;
  /** Every update received so far, in arrival order (each checked against the shared schema). */
  updates: StateUpdate[];
  /** The next update not yet taken by `next`. */
  next(): Promise<StateUpdate>;
  /** Round trip: resolves with a fresh snapshot once all earlier server packets have arrived. */
  sync(): Promise<StateSnapshot>;
}

/** Connect a client with its listeners registered before the connection opens. */
async function connect(url: string): Promise<Client> {
  const socket = connectClient(url, { transports: ["websocket"], forceNew: true, reconnection: false, autoConnect: false });
  sockets.push(socket);
  const updates: StateUpdate[] = [];
  const waiting: ((u: StateUpdate) => void)[] = [];
  let taken = 0;
  socket.on(UPDATE_EVENT, (raw: unknown) => {
    const u = StateUpdate.parse(raw);
    updates.push(u);
    waiting.shift()?.(u);
  });
  const first = new Promise<StateSnapshot>((resolve) => socket.once(SNAPSHOT_EVENT, (raw: unknown) => resolve(StateSnapshot.parse(raw))));
  socket.connect();
  const snapshot = await within(first, "the connection snapshot");
  return {
    socket, snapshot, updates,
    next: () => {
      const i = taken++;
      if (updates[i]) return Promise.resolve(updates[i]!);
      return within(new Promise<StateUpdate>((resolve) => waiting.push(resolve)), `update #${i + 1}`);
    },
    sync: async () => StateSnapshot.parse(await within(socket.emitWithAck(SNAPSHOT_REQUEST_EVENT), "a snapshot acknowledgement")),
  };
}

const rest = (app: FastifyInstance, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
const createRide = async (app: FastifyInstance, pickupId = "c", destinationId = "e") => {
  const res = await rest(app, "POST", "/api/ride-requests", { studentId: "stu-lina", pickupId, destinationId });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};
const act = (app: FastifyInstance, id: string, action: string) => rest(app, "POST", `/api/ride-requests/${id}/${action}`);
const advanceBy = (app: FastifyInstance, seconds: number) => rest(app, "POST", "/api/simulation/advance", { seconds });
const restSnapshot = async (app: FastifyInstance) => StateSnapshot.parse((await rest(app, "GET", "/api/snapshot")).json());

// ---------- Connection and snapshots (1, 2, 17) ----------

describe("connection snapshot", () => {
  it("a new client first gets the full state at revision 0, identical to GET /api/snapshot", async () => {
    const live = await liveApp([cartAt("CART-02", "e"), cartAt("CART-01", "a")]);
    const c = await connect(live.url);
    expect(c.snapshot).toEqual({
      revision: 0, campusId: "line", clockSeconds: 0, requests: [], trips: [],
      carts: [expect.objectContaining({ id: "CART-01", status: "idle" }), expect.objectContaining({ id: "CART-02", status: "idle" })],
    });
    expect(c.snapshot).toEqual(await restSnapshot(live.app));
  });

  it("a client joining later gets a snapshot whose revision matches exactly the state it shows", async () => {
    const live = await liveApp();
    const id = await createRide(live.app);
    await act(live.app, id, "dispatch");
    await act(live.app, id, "start");
    await advanceBy(live.app, 5);
    const c = await connect(live.url);
    expect(c.snapshot.revision).toBe(4);
    expect(c.snapshot.clockSeconds).toBe(5);
    expect(c.snapshot.requests).toEqual([expect.objectContaining({ id, status: "arriving" })]);
    expect(c.snapshot.trips).toEqual([expect.objectContaining({ id: "TRIP-0001", status: "active" })]);
    expect(c.snapshot.carts[0]).toMatchObject({ status: "assigned", position: { kind: "on_path", pathId: "ab", progress: 0.5 } });
    expect(c.snapshot).toEqual(await restSnapshot(live.app));
    // The next change reaches it as revision 5, never as something older than its snapshot.
    await advanceBy(live.app, 1);
    expect((await c.next()).revision).toBe(5);
  });

  it("a client that disconnects and reconnects gets a fresh snapshot with everything it missed", async () => {
    const live = await liveApp();
    const c = await connect(live.url);
    const id = await createRide(live.app);
    expect((await c.next()).revision).toBe(1);
    c.socket.disconnect();
    await act(live.app, id, "dispatch");
    await act(live.app, id, "start");
    const back = await connect(live.url);
    expect(back.snapshot.revision).toBe(3);
    expect(back.snapshot.requests[0]).toMatchObject({ id, status: "arriving" });
    expect(back.snapshot).toEqual(await restSnapshot(live.app));
    expect(c.updates.map((u) => u.revision)).toEqual([1]);
  });
});

// ---------- One update per operation, through a whole ride (3-10, 13-15) ----------

describe("updates for each operation", () => {
  it("every step of a ride sends exactly one coherent update, to every client, matching the REST state", async () => {
    const live = await liveApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const a = await connect(live.url);
    const b = await connect(live.url);
    const step = async (run: () => Promise<{ statusCode: number }>, expected: number) => {
      expect((await run()).statusCode).toBeLessThan(300);
      const u = await a.next();
      expect(u.revision).toBe(expected);
      expect(await b.next()).toEqual(u);
      expect((await a.sync()).revision).toBe(expected); // and nothing else arrived
      expect(a.updates).toHaveLength(expected);
      return u;
    };

    const created = await step(async () => rest(live.app, "POST", "/api/ride-requests", { studentId: "stu-lina", pickupId: "c", destinationId: "e" }), 1);
    expect(created).toEqual({ revision: 1, operation: "ride_request.created", clockSeconds: 0, requests: [expect.objectContaining({ id: "REQ-0001", status: "requested" })], trips: [], carts: [] });
    const id = created.requests[0]!.id;

    const dispatched = await step(() => act(live.app, id, "dispatch"), 2);
    expect(dispatched).toMatchObject({ operation: "ride.dispatched", requests: [{ id, status: "assigned" }], trips: [{ id: "TRIP-0001", cartId: "CART-01", status: "planned" }], carts: [{ id: "CART-01", status: "assigned" }] });

    const started = await step(() => act(live.app, id, "start"), 3);
    expect(started).toMatchObject({ operation: "ride.started", requests: [{ status: "arriving" }], trips: [{ status: "active", leg: { locationIds: ["a", "b", "c"] } }], carts: [] });

    // One advance moves the cart. Phase 4: the trip's actual driving time (drivenSeconds) changes too,
    // so the moving trip is listed with the cart.
    const moved = await step(() => advanceBy(live.app, 20), 4);
    expect(moved).toEqual({ revision: 4, operation: "simulation.advanced", clockSeconds: 20, requests: [], trips: [expect.objectContaining({ id: "TRIP-0001", status: "active", drivenSeconds: 20 })], carts: [expect.objectContaining({ id: "CART-01", position: { kind: "at", locationId: "c" } })] });

    const boarded = await step(() => act(live.app, id, "board"), 5);
    expect(boarded).toMatchObject({ operation: "ride.boarded", requests: [{ status: "on_board" }], trips: [{ stopIndex: 1 }], carts: [{ status: "occupied", passengerCount: 1 }] });

    await step(() => advanceBy(live.app, 20), 6);
    const done = await step(() => act(live.app, id, "drop-off"), 7);
    expect(done).toMatchObject({ operation: "ride.dropped_off", requests: [{ status: "completed" }], trips: [{ status: "completed" }], carts: [{ id: "CART-01", status: "idle", passengerCount: 0, position: { kind: "at", locationId: "e" } }] });

    // Each update lists the entities exactly as REST shows them after the commit.
    expect(done.requests[0]).toEqual((await rest(live.app, "GET", `/api/ride-requests/${id}`)).json());
    expect(done.trips[0]).toEqual((await rest(live.app, "GET", `/api/ride-requests/${id}/trip`)).json().trip);
    expect(done.carts[0]).toEqual((await rest(live.app, "GET", "/api/carts/CART-01")).json());
    expect(a.updates.map((u) => u.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(b.updates).toEqual(a.updates);
    // Replaying the updates on top of the first snapshot gives the current snapshot.
    expect(replay(a.snapshot, a.updates)).toEqual(await restSnapshot(live.app));
  });

  it("cancellation and its mid-path cleanup each send one update; the cleanup is part of the advance that finishes it", async () => {
    const live = await liveApp();
    const c = await connect(live.url);
    const id = await createRide(live.app, "d", "e");
    await act(live.app, id, "dispatch");
    await act(live.app, id, "start");
    await advanceBy(live.app, 15);
    expect((await act(live.app, id, "cancel")).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) await c.next();
    const cancelled = await c.next();
    expect(cancelled).toMatchObject({ revision: 5, operation: "ride.cancelled", requests: [{ id, status: "cancelled" }], trips: [{ status: "cancelling", leg: { pathIds: ["bc"] } }], carts: [] });

    const cleanup = (await advanceBy(live.app, 30)).json();
    const u = await c.next();
    expect(u).toMatchObject({
      revision: 6, operation: "simulation.advanced", clockSeconds: 45, requests: [],
      trips: [{ id: "TRIP-0001", status: "cancelled", leg: null }],
      carts: [{ id: "CART-01", status: "idle", position: { kind: "at", locationId: "c" } }],
    });
    expect(u.carts).toEqual(cleanup.carts);

    // Cancelling a requested ride: only the request changes.
    const other = await createRide(live.app);
    await c.next();
    await act(live.app, other, "cancel");
    expect(await c.next()).toEqual({ revision: 8, operation: "ride.cancelled", clockSeconds: 45, requests: [expect.objectContaining({ id: other, status: "cancelled" })], trips: [], carts: [] });
  });

  it("an advance that moves several carts sends one update with all of them at the same revision", async () => {
    const live = await liveApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const c = await connect(live.url);
    const r1 = await createRide(live.app, "c", "d");
    const r2 = await createRide(live.app, "c", "b");
    for (const id of [r1, r2]) { await act(live.app, id, "dispatch"); await act(live.app, id, "start"); }
    await advanceBy(live.app, 5);
    for (let i = 0; i < 6; i++) await c.next();
    const u = await c.next();
    expect(u).toMatchObject({ revision: 7, operation: "simulation.advanced", clockSeconds: 5 });
    expect(u.carts.map((x) => [x.id, x.position])).toEqual([
      ["CART-01", { kind: "on_path", pathId: "ab", progress: 0.5 }],
      ["CART-02", { kind: "on_path", pathId: "de", progress: 0.5 }],
    ]);
    expect((await c.sync()).revision).toBe(7);
    expect(c.updates).toHaveLength(7);
  });

  it("an advance with nothing moving still commits the clock, so it is one revision with no entities", async () => {
    const live = await liveApp();
    const c = await connect(live.url);
    await advanceBy(live.app, 10);
    expect(await c.next()).toEqual({ revision: 1, operation: "simulation.advanced", clockSeconds: 10, requests: [], trips: [], carts: [] });
  });
});

// ---------- Failures, no-ops and delivery (11, 12, 16) ----------

describe("failed and no-op operations", () => {
  it("rejected REST calls send nothing and do not move the revision", async () => {
    const live = await liveApp([cartAt("CART-01", "a", { status: "charging" })]);
    const c = await connect(live.url);
    const id = await createRide(live.app);
    await c.next();
    const before = await restSnapshot(live.app);
    const failures = [
      rest(live.app, "POST", "/api/ride-requests", { studentId: "s", pickupId: "nowhere", destinationId: "e" }),
      rest(live.app, "POST", "/api/ride-requests", { studentId: "s", pickupId: "c", destinationId: "e", fareJod: 0 }),
      act(live.app, id, "dispatch"), // 409 NO_CART_AVAILABLE: the only cart is charging
      act(live.app, id, "start"),
      act(live.app, id, "board"),
      act(live.app, "REQ-0404", "cancel"),
      rest(live.app, "POST", "/api/simulation/advance", { seconds: 0 }),
      rest(live.app, "POST", "/api/simulation/advance", { seconds: 601 }),
    ];
    for (const r of await Promise.all(failures)) expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const after = await c.sync();
    expect(after).toEqual(before);
    expect(after.revision).toBe(1);
    expect(c.updates.map((u) => u.revision)).toEqual([1]);
    // The next success is revision 2: no number was used up by the failures.
    await act(live.app, id, "cancel");
    expect((await c.next()).revision).toBe(2);
  });

  it("a failed multi-trip advance sends no partial update and keeps the state and revision", async () => {
    const live = await liveApp([cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const c = await connect(live.url);
    const r1 = await createRide(live.app, "c", "d");
    const r2 = await createRide(live.app, "c", "b");
    for (const id of [r1, r2]) { await act(live.app, id, "dispatch"); await act(live.app, id, "start"); }
    const before = await c.sync();
    expect(before.revision).toBe(6);
    // Failure injection (as in the engine tests): TRIP-0002's path disappears, so the real `advance`
    // fails after it already moved TRIP-0001 in its working copy.
    const result = live.store.apply((s) => {
      const paths = new Map(s.graph.paths);
      paths.delete("de");
      return advance({ ...s, graph: { ...s.graph, paths } }, 5);
    }, "simulation.advanced");
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_MOVEMENT" } });
    const after = await c.sync();
    expect(after).toEqual(before);
    expect(c.updates).toHaveLength(6);
    expect(await restSnapshot(live.app)).toEqual(before);
  });

  it("an operation that returns the same state is a no-op: no revision, no update", async () => {
    const live = await liveApp();
    const c = await connect(live.url);
    expect(live.store.apply((s) => ({ ok: true as const, state: s })).ok).toBe(true);
    expect((await c.sync()).revision).toBe(0);
    expect(c.updates).toEqual([]);
  });

  it("socket events cannot change state: unknown client events are ignored", async () => {
    const live = await liveApp();
    const c = await connect(live.url);
    c.socket.emit("ride:create", { studentId: "s", pickupId: "c", destinationId: "e" });
    c.socket.emit("simulation:advance", { seconds: 10 });
    c.socket.emit(SNAPSHOT_REQUEST_EVENT); // no acknowledgement callback: ignored, nothing breaks
    const s = await c.sync();
    expect(s).toMatchObject({ revision: 0, clockSeconds: 0, requests: [] });
    expect(c.updates).toEqual([]);
  });

  it("a commit stays committed when a client has gone away or a listener fails", async () => {
    const live = await liveApp();
    const gone = await connect(live.url);
    gone.socket.disconnect();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    const stop = live.store.onCommit(() => { throw new Error("delivery broke"); });
    try {
      const id = await createRide(live.app);
      expect((await restSnapshot(live.app)).revision).toBe(1);
      expect((await rest(live.app, "GET", `/api/ride-requests/${id}`)).statusCode).toBe(200);
      expect(errors).toHaveLength(1);
    } finally {
      stop();
      console.error = original;
    }
    // Other subscribers still get the update for the next commit.
    const c = await connect(live.url);
    await advanceBy(live.app, 1);
    expect((await c.next()).revision).toBe(2);
  });
});

// ---------- Revision contract for clients (18, 19) ----------

describe("client revision contract", () => {
  it("classifies the next revision, duplicates, old revisions and gaps", () => {
    expect(classifyRevision(3, 4)).toBe("apply");
    expect(classifyRevision(3, 3)).toBe("stale");
    expect(classifyRevision(3, 1)).toBe("stale");
    expect(classifyRevision(3, 5)).toBe("gap");
    expect(classifyRevision(0, 1)).toBe("apply");
  });

  it("a client that misses an update detects the gap and recovers with a fresh snapshot", async () => {
    const live = await liveApp();
    const c = await connect(live.url);
    let held = c.snapshot;
    const id = await createRide(live.app);
    const u1 = await c.next();
    expect(classifyRevision(held.revision, u1.revision)).toBe("apply");
    held = replay(held, [u1]);
    // Pretend the dispatch update was lost in transit: the client never sees revision 2.
    await act(live.app, id, "dispatch");
    await c.next();
    await act(live.app, id, "start");
    const u3 = await c.next();
    expect(classifyRevision(held.revision, u3.revision)).toBe("gap");
    const fresh = await c.sync();
    expect(fresh.revision).toBe(3);
    expect(fresh).toEqual(await restSnapshot(live.app));
    // Receiving the same update again later is recognised as stale.
    expect(classifyRevision(fresh.revision, u3.revision)).toBe("stale");
  });
});

// ---------- Isolation and shutdown (20, 21) ----------

describe("isolated instances", () => {
  it("two apps share no clients, events, revisions or state", async () => {
    const one = await liveApp();
    const two = await liveApp();
    const c1 = await connect(one.url);
    const c2 = await connect(two.url);
    await createRide(one.app);
    await createRide(one.app);
    expect((await c1.next()).revision).toBe(1);
    expect((await c1.next()).revision).toBe(2);
    expect((await c2.sync()).revision).toBe(0);
    expect(c2.updates).toEqual([]);
    await advanceBy(two.app, 3);
    expect(await c2.next()).toMatchObject({ revision: 1, clockSeconds: 3 });
    expect((await c1.sync()).clockSeconds).toBe(0);
  });

  it("closing one app disconnects its clients and releases its port; the other app keeps working", async () => {
    const one = await liveApp();
    const two = await liveApp();
    const c1 = await connect(one.url);
    const c2 = await connect(two.url);
    const dropped = new Promise<string>((resolve) => c1.socket.once("disconnect", (reason) => resolve(reason)));
    await within(one.app.close(), "the first app to close");
    apps.splice(apps.indexOf(one.app), 1);
    expect(await within(dropped, "the first client to be disconnected")).toBe("io server disconnect");
    expect(one.app.server.listening).toBe(false);
    expect(c2.socket.connected).toBe(true);
    await createRide(two.app);
    expect((await c2.next()).revision).toBe(1);
  });

  it("an app that never listens (REST tests) still closes cleanly", async () => {
    const campus = lineCampus();
    const fleet = createFleet(campus, [cartAt("CART-01", "a")]);
    if (!fleet.ok) throw new Error("fleet");
    const app = await buildApp({ store: createAppStore(campus, fleet.fleet) });
    expect((await app.inject("/api/snapshot")).json().revision).toBe(0);
    await within(app.close(), "the app to close");
  });
});

/** Apply updates to a snapshot the way a client would, following the revision contract. */
function replay(start: StateSnapshot, updates: StateUpdate[]): StateSnapshot {
  let s = structuredClone(start);
  for (const u of updates) {
    const verdict = classifyRevision(s.revision, u.revision);
    if (verdict === "stale") continue;
    if (verdict === "gap") throw new Error(`gap at ${u.revision}`);
    const merge = <T extends { id: string }>(list: T[], changed: T[]) => {
      const m = new Map(list.map((x) => [x.id, x]));
      for (const x of changed) m.set(x.id, x);
      return [...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    };
    s = { ...s, revision: u.revision, clockSeconds: u.clockSeconds, requests: merge(s.requests, u.requests), trips: merge(s.trips, u.trips), carts: merge(s.carts, u.carts) };
  }
  return s;
}
