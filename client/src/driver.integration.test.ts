/**
 * Phase 3 Prompt 2: Driver Mode's data layer against a REAL server (Fastify + Socket.IO on a random
 * port, real engine, real REST routes, real socket.io-client). The client side is the same
 * realtimeStore, driverWork, driverActions and rideApi code the app uses. No sleeps: every wait is a
 * store event or an explicit promise, with a bounded timeout.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { io, type Socket } from "socket.io-client";
import { UPDATE_EVENT } from "../../shared/realtime";
import { createDriverActionController } from "./lib/driverActions";
import { openTripsForCart } from "./lib/driverWork";
import { createRealtimeStore, type RealtimeSocket, type RealtimeStore } from "./lib/realtimeStore";
import { createDriverApi, type DriverApi } from "./lib/rideApi";
import { cartAt, lineCampus, liveApp, waitFor, type Live } from "./lib/testSupport";

const apps: FastifyInstance[] = [];
const stores: RealtimeStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.stop();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const CARTS = [cartAt("CART-01", "a", { driverId: "drv-yazan" }), cartAt("CART-02", "e", { driverId: "drv-rana" })];
const post = (live: Live, url: string, payload: object = {}) => live.app.inject({ method: "POST", url, payload });
const socketFor = (live: Live): Socket => io(live.url, { transports: ["websocket"], forceNew: true, autoConnect: false, reconnection: false });

async function connected(live: Live, socket: RealtimeSocket = socketFor(live)) {
  const store = createRealtimeStore({ socket, fetchSnapshot: () => fetch(`${live.url}/api/snapshot`).then((r) => r.json()) });
  stores.push(store);
  store.start();
  await waitFor(store, "the first snapshot", (s) => s.status === "live" && s.data !== null);
  return store;
}
const atRevision = (store: RealtimeStore, rev: number) => waitFor(store, `revision ${rev}`, (s) => s.data?.revision === rev && s.status === "live");

/** A dispatched ride on CART-01 (revisions 1 and 2). */
async function dispatched(live: Live, pickupId = "c", destinationId = "e") {
  const created = await post(live, "/api/ride-requests", { studentId: "stu-lina", pickupId, destinationId });
  const id = created.json().id as string;
  const d = await post(live, `/api/ride-requests/${id}/dispatch`);
  expect(d.json().cart.id).toBe("CART-01");
  return id;
}

/** Records every request URL the Driver API sends, and lets a test hold a response until it says so. */
function recordingApi(live: Live) {
  const urls: string[] = [];
  let hold: Promise<void> | null = null;
  const api: DriverApi = createDriverApi(live.url, async (input, init) => {
    urls.push(String(input));
    const res = await fetch(input, init);
    if (hold) await hold; // the server has already committed; only the answer is delayed
    return res;
  });
  return { api, urls, holdResponses: () => { let release!: () => void; hold = new Promise<void>((r) => (release = r)); return () => { hold = null; release(); }; } };
}

describe("Driver Mode against the real server", () => {
  it("start, board and drop-off go to the exact request id; the screen moves only on the server's updates", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const id = await dispatched(live);
    await atRevision(store, 2);
    const { api, urls } = recordingApi(live);
    const actions = createDriverActionController({ api, currentData: () => store.getState().data, resync: () => store.resync() });
    const step = () => openTripsForCart(store.getState().data!, "CART-01")[0]!;

    expect(step().next).toMatchObject({ action: "start", requestId: id, tripId: "TRIP-0001" });
    expect(await actions.submit(step().next!)).toBe("sent");
    await atRevision(store, 3);
    expect(step().stage).toBe("to_pickup");
    await post(live, "/api/simulation/advance", { seconds: 600 });
    await atRevision(store, 4);
    expect(await actions.submit(step().next!)).toBe("sent");
    await atRevision(store, 5);
    await post(live, "/api/simulation/advance", { seconds: 600 });
    await atRevision(store, 6);
    expect(await actions.submit(step().next!)).toBe("sent");
    await atRevision(store, 7);
    expect(urls).toEqual([
      `${live.url}/api/ride-requests/${id}/start`,
      `${live.url}/api/ride-requests/${id}/board`,
      `${live.url}/api/ride-requests/${id}/drop-off`,
    ]);
    expect(openTripsForCart(store.getState().data!, "CART-01")).toEqual([]);
    expect(store.getState().data!.requests[0]!.status).toBe("completed");
    expect(actions.getState()).toMatchObject({ status: "success", message: "Drop-off confirmed. Ride completed." });
  });

  it("repeated taps send one request; a socket update arriving before the REST answer does not allow a second send", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    await dispatched(live);
    await atRevision(store, 2);
    const { api, urls, holdResponses } = recordingApi(live);
    const actions = createDriverActionController({ api, currentData: () => store.getState().data, resync: () => store.resync() });
    const binding = openTripsForCart(store.getState().data!, "CART-01")[0]!.next!;

    const release = holdResponses();
    const first = actions.submit(binding);
    const second = actions.submit(binding);
    expect(await second).toBe("ignored");
    // The server committed the start and the socket delivered it while the REST answer is held back.
    await atRevision(store, 3);
    expect(actions.getState().status).toBe("pending"); // no success shown before the server's REST answer
    expect(await actions.submit(binding)).toBe("ignored");
    release();
    expect(await first).toBe("sent");
    expect(actions.getState()).toMatchObject({ status: "success", message: "Trip started." });
    expect(urls).toHaveLength(1);
    // The (older) REST response never replaced the live state, which stays at the newer revision.
    expect(store.getState().data!.revision).toBe(3);
  });

  it("a REST answer that arrives after newer socket revisions does not roll the state back", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    await dispatched(live);
    await atRevision(store, 2);
    const { api, holdResponses } = recordingApi(live);
    const actions = createDriverActionController({ api, currentData: () => store.getState().data, resync: () => store.resync() });
    const release = holdResponses();
    const sending = actions.submit(openTripsForCart(store.getState().data!, "CART-01")[0]!.next!);
    await atRevision(store, 3); // start committed
    await post(live, "/api/simulation/advance", { seconds: 600 }); // newer: cart reaches the pickup
    await atRevision(store, 4);
    release();
    expect(await sending).toBe("sent");
    expect(store.getState().data!.revision).toBe(4);
    expect(openTripsForCart(store.getState().data!, "CART-01")[0]!.stage).toBe("at_pickup");
  });

  it("a rejected step shows the server's reason and no success; a changed ride is refused before sending", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const id = await dispatched(live);
    await atRevision(store, 2);
    const { api, urls } = recordingApi(live);
    const stale = structuredClone(store.getState().data!); // the screen as it was: "Start trip" offered
    const binding = openTripsForCart(stale, "CART-01")[0]!.next!;

    // Another device starts the trip first.
    await post(live, `/api/ride-requests/${id}/start`);
    await atRevision(store, 3);

    // Against the live state, the old button is refused locally and nothing is sent.
    const live1 = createDriverActionController({ api, currentData: () => store.getState().data, resync: () => store.resync() });
    expect(await live1.submit(binding)).toBe("stale");
    expect(live1.getState()).toMatchObject({ status: "error", code: "STALE_STATE" });
    expect(urls).toEqual([]);

    // If it is sent anyway (screen data older than the server), the server refuses and that is shown.
    const old = createDriverActionController({ api, currentData: () => stale, resync: () => {} });
    expect(await old.submit(binding)).toBe("failed");
    expect(old.getState()).toMatchObject({ status: "error", code: "INVALID_TRANSITION" });
    expect(urls).toHaveLength(1);
    expect(store.getState().data!.revision).toBe(3); // nothing committed by the refused call
  });

  it("an unreachable server is an error, never a success, and is not retried", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    await dispatched(live);
    await atRevision(store, 2);
    const data = structuredClone(store.getState().data!);
    let calls = 0;
    const api: DriverApi = createDriverApi("http://127.0.0.1:9", async (input, init) => { calls += 1; return fetch(input, init); });
    const actions = createDriverActionController({ api, currentData: () => data, resync: () => {} });
    expect(await actions.submit(openTripsForCart(data, "CART-01")[0]!.next!)).toBe("failed");
    expect(actions.getState()).toMatchObject({ status: "error", code: "NETWORK_ERROR" });
    expect(calls).toBe(1);
  });

  it("a missed update and a dropped connection both recover the driver's trip from server snapshots", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const raw = socketFor(live);
    // Lose revision 2 (the dispatch) on the way.
    const wrapped = new Map<unknown, (...a: unknown[]) => void>();
    const losing: RealtimeSocket = {
      get connected() { return raw.connected; },
      on: (e, fn) => { const g = e === UPDATE_EVENT ? (x: unknown) => { if ((x as { revision: number }).revision !== 2) fn(x); } : fn; wrapped.set(fn, g); raw.on(e, g); },
      off: (e, fn) => { raw.off(e, wrapped.get(fn) ?? fn); },
      connect: () => raw.connect(),
      disconnect: () => raw.disconnect(),
      timeout: (ms) => raw.timeout(ms),
    };
    const store = await connected(live, losing);
    const id = await dispatched(live);
    await post(live, `/api/ride-requests/${id}/start`); // revision 3 -> gap -> snapshot
    await atRevision(store, 3);
    expect(openTripsForCart(store.getState().data!, "CART-01")[0]!.stage).toBe("to_pickup");

    raw.io.engine.close();
    await waitFor(store, "offline", (s) => s.status === "offline");
    await post(live, "/api/simulation/advance", { seconds: 600 }); // missed while offline
    raw.connect();
    await atRevision(store, 4);
    expect(openTripsForCart(store.getState().data!, "CART-01")[0]).toMatchObject({ stage: "at_pickup", next: { action: "board" } });
  });

  it("each driver sees only their own cart's trip", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    await dispatched(live, "b", "c"); // CART-01
    const omar = (await post(live, "/api/ride-requests", { studentId: "stu-omar", pickupId: "d", destinationId: "e" })).json().id as string;
    expect((await post(live, `/api/ride-requests/${omar}/dispatch`)).json().cart.id).toBe("CART-02");
    await atRevision(store, 4);
    const data = store.getState().data!;
    expect(openTripsForCart(data, "CART-01").map((t) => t.request!.studentId)).toEqual(["stu-lina"]);
    expect(openTripsForCart(data, "CART-02").map((t) => t.request!.studentId)).toEqual(["stu-omar"]);
  });
});
