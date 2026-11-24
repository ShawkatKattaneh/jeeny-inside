/**
 * Phase 3 Prompt 3: the Operations Dashboard's data layer against a REAL server (Fastify + Socket.IO
 * on a random port, real engine and REST routes, real socket.io-client). The client side is the same
 * realtimeStore, opsActions and rideApi code the app uses. No sleeps: every wait is a store event or an
 * explicit promise with a bounded timeout.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { io, type Socket } from "socket.io-client";
import { UPDATE_EVENT } from "../../shared/realtime";
import { createAdvanceController, createDispatchController } from "./lib/opsActions";
import { opsMetrics } from "./lib/opsMetrics";
import { createRealtimeStore, type RealtimeSocket, type RealtimeStore } from "./lib/realtimeStore";
import { createOpsApi, type OpsApi } from "./lib/rideApi";
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
const requestRide = async (live: Live, pickupId = "c", destinationId = "e", studentId = "stu-lina") =>
  (await post(live, "/api/ride-requests", { studentId, pickupId, destinationId })).json().id as string;

/** Records every request the Ops API sends, and can hold a response after the server has answered. */
function recordingApi(live: Live, baseUrl = live.url) {
  const sent: { url: string; body: string }[] = [];
  let hold: Promise<void> | null = null;
  const api: OpsApi = createOpsApi(baseUrl, async (input, init) => {
    sent.push({ url: String(input), body: String(init?.body ?? "") });
    const res = await fetch(input, init);
    if (hold) await hold; // the server has already committed; only the answer is delayed
    return res;
  });
  return { api, sent, holdResponses: () => { let release!: () => void; hold = new Promise<void>((r) => (release = r)); return () => { hold = null; release(); }; } };
}
function controllers(api: OpsApi, store: RealtimeStore) {
  const deps = { api, currentData: () => store.getState().data, resync: () => store.resync() };
  return { dispatch: createDispatchController(deps), advance: createAdvanceController(deps) };
}

describe("dispatch against the real server", () => {
  it("dispatches exactly the chosen request; the trip and cart appear only through the server's update", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const id = await requestRide(live);
    await atRevision(store, 1);
    const { api, sent } = recordingApi(live);
    const { dispatch } = controllers(api, store);

    expect(opsMetrics(store.getState().data!).requests.awaitingDispatch).toBe(1);
    expect(await dispatch.submit(id)).toBe("sent");
    expect(sent).toEqual([{ url: `${live.url}/api/ride-requests/${id}/dispatch`, body: "{}" }]);
    const st = dispatch.getState();
    expect(st.status).toBe("success");
    if (st.status !== "success") return;
    expect(st.result.cart.id).toBe("CART-01");
    expect(st.result.selection.selectedCartId).toBe("CART-01");
    expect(st.result.selection.candidates.map((c) => c.cartId)).toEqual(["CART-01", "CART-02"]);
    await atRevision(store, 2);
    const m = opsMetrics(store.getState().data!);
    expect(m.requests.byStatus.assigned).toBe(1);
    expect(m.trips.byStatus.planned).toBe(1);
    expect(m.carts.byStatus.assigned).toBe(1);
  });

  it("NO_CART_AVAILABLE is shown with the server's per-cart reasons, nothing changes, and idle-but-unusable carts are explained by the server", async () => {
    // CART-01 is idle but below the battery reserve; CART-02 is charging. Only the server knows which are usable.
    const live = await liveApp(apps, lineCampus(), [cartAt("CART-01", "a", { batteryPercent: 10 }), cartAt("CART-02", "e", { status: "charging" })]);
    const store = await connected(live);
    const id = await requestRide(live);
    await atRevision(store, 1);
    expect(opsMetrics(store.getState().data!).carts.byStatus.idle).toBe(1);
    const { api, sent } = recordingApi(live);
    const { dispatch } = controllers(api, store);

    expect(await dispatch.submit(id)).toBe("failed");
    const st = dispatch.getState();
    expect(st).toMatchObject({ status: "error", requestId: id, code: "NO_CART_AVAILABLE" });
    if (st.status !== "error") return;
    expect(st.selection?.selectedCartId).toBeNull();
    expect(st.selection?.candidates.every((c) => !c.eligible && c.excludedReason)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(store.getState().data!.revision).toBe(1);
    expect(store.getState().data!.requests[0]!.status).toBe("requested");
  });

  it("repeated clicks send one dispatch; a socket update before the REST answer does not allow a second send", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const id = await requestRide(live);
    await atRevision(store, 1);
    const { api, sent, holdResponses } = recordingApi(live);
    const { dispatch } = controllers(api, store);

    const release = holdResponses();
    const first = dispatch.submit(id);
    expect(await dispatch.submit(id)).toBe("ignored");
    await atRevision(store, 2); // committed and broadcast while the REST answer is held
    expect(dispatch.getState().status).toBe("pending"); // no success before the REST answer
    expect(await dispatch.submit(id)).toBe("ignored");
    release();
    expect(await first).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(store.getState().data!.revision).toBe(2);
  });

  it("a request that already changed is refused before sending; sent from older data, the server's refusal is shown", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const id = await requestRide(live);
    await atRevision(store, 1);
    const stale = structuredClone(store.getState().data!);
    await post(live, `/api/ride-requests/${id}/dispatch`); // another operator dispatched it
    await atRevision(store, 2);
    const { api, sent } = recordingApi(live);

    expect(await controllers(api, store).dispatch.submit(id)).toBe("stale");
    expect(sent).toEqual([]);
    const old = createDispatchController({ api, currentData: () => stale, resync: () => {} });
    expect(await old.submit(id)).toBe("failed");
    expect(old.getState()).toMatchObject({ status: "error", code: "INVALID_TRANSITION" });
    expect(store.getState().data!.revision).toBe(2);
  });

  it("an unknown request and an unreachable server are errors, never successes, and are not retried", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const { api } = recordingApi(live);
    const fake = structuredClone(store.getState().data!);
    // A believable "requested" request the server has never seen, so the call is sent and answered 404.
    fake.requests = [{ id: "REQ-9999", studentId: "stu-lina", pickupId: "c", destinationId: "e", mode: "solo", status: "requested", fareJod: 0.25, freeLoyaltyRide: false, createdAt: 0, updatedAt: 0 } as never];
    const unknown = createDispatchController({ api, currentData: () => fake, resync: () => {} });
    expect(await unknown.submit("REQ-9999")).toBe("failed");
    expect(unknown.getState()).toMatchObject({ status: "error", code: "UNKNOWN_REQUEST" });

    let calls = 0;
    const down = createOpsApi("http://127.0.0.1:9", async (input, init) => { calls += 1; return fetch(input, init); });
    const net = createDispatchController({ api: down, currentData: () => fake, resync: () => {} });
    expect(await net.submit("REQ-9999")).toBe("failed");
    expect(net.getState()).toMatchObject({ status: "error", code: "NETWORK_ERROR" });
    expect(calls).toBe(1);
  });
});

describe("simulation advance against the real server", () => {
  it("advances by the requested seconds; the confirmed clock is the server's and the view follows its update", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const { api, sent } = recordingApi(live);
    const { advance } = controllers(api, store);
    expect(await advance.submit(30)).toBe("sent");
    expect(sent).toEqual([{ url: `${live.url}/api/simulation/advance`, body: '{"seconds":30}' }]);
    expect(advance.getState()).toEqual({ status: "success", seconds: 30, clockSeconds: 30 });
    await atRevision(store, 1);
    expect(store.getState().data!.clockSeconds).toBe(30);
    expect(await advance.submit(45)).toBe("sent");
    expect(advance.getState()).toMatchObject({ clockSeconds: 75 });
    await atRevision(store, 2);
  });

  it("invalid durations are refused locally and never sent; the server's own validation is shown when bypassed", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const { api, sent } = recordingApi(live);
    const { advance } = controllers(api, store);
    for (const bad of [0, -1, 601, Number.NaN, "30"]) expect(await advance.submit(bad)).toBe("invalid");
    expect(sent).toEqual([]);
    expect(advance.getState()).toMatchObject({ status: "error", code: "INVALID_REQUEST" });
    const direct = await api.advance({ seconds: 601 });
    expect(direct).toMatchObject({ ok: false, status: 400, code: "INVALID_REQUEST" });
    expect(store.getState().data!.revision).toBe(0);
    expect(store.getState().data!.clockSeconds).toBe(0);
  });

  it("overlapping advances are prevented: one request while one is in flight", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const { api, sent, holdResponses } = recordingApi(live);
    const { advance } = controllers(api, store);
    const release = holdResponses();
    const first = advance.submit(60);
    expect(await advance.submit(60)).toBe("ignored");
    await atRevision(store, 1);
    expect(advance.getState()).toEqual({ status: "pending", seconds: 60 });
    expect(await advance.submit(60)).toBe("ignored");
    release();
    expect(await first).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(store.getState().data!.clockSeconds).toBe(60);
  });

  it("a REST answer arriving after newer revisions does not roll the state back; advance is never re-issued", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const store = await connected(live);
    const { api, sent, holdResponses } = recordingApi(live);
    const { advance } = controllers(api, store);
    const release = holdResponses();
    const sending = advance.submit(10);
    await atRevision(store, 1);
    await post(live, "/api/simulation/advance", { seconds: 20 }); // newer, from elsewhere
    await atRevision(store, 2);
    release();
    expect(await sending).toBe("sent");
    expect(advance.getState()).toMatchObject({ status: "success", clockSeconds: 10 });
    expect(store.getState().data).toMatchObject({ revision: 2, clockSeconds: 30 });
    expect(sent).toHaveLength(1);
  });

  it("when the update is lost, a confirmed advance asks for a snapshot (resync), not a second advance", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const raw = socketFor(live);
    const wrapped = new Map<unknown, (...a: unknown[]) => void>();
    const deaf: RealtimeSocket = {
      get connected() { return raw.connected; },
      on: (e, fn) => { const g = e === UPDATE_EVENT ? () => {} : fn; wrapped.set(fn, g); raw.on(e, g); },
      off: (e, fn) => { raw.off(e, wrapped.get(fn) ?? fn); },
      connect: () => raw.connect(),
      disconnect: () => raw.disconnect(),
      timeout: (ms) => raw.timeout(ms),
    };
    const store = await connected(live, deaf);
    const { api, sent } = recordingApi(live);
    const { advance } = controllers(api, store);
    expect(await advance.submit(90)).toBe("sent");
    await waitFor(store, "the resync snapshot", (s) => s.data?.clockSeconds === 90 && s.status === "live");
    expect(sent).toHaveLength(1);
    expect(store.getState().data!.revision).toBe(1);
  });
});

describe("realtime recovery", () => {
  it("a missed update and a dropped connection both recover counts from server snapshots", async () => {
    const live = await liveApp(apps, lineCampus(), CARTS);
    const raw = socketFor(live);
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
    const id = await requestRide(live); // 1
    await post(live, `/api/ride-requests/${id}/dispatch`); // 2 (lost)
    await requestRide(live, "b", "d", "stu-omar"); // 3 -> gap -> snapshot
    await atRevision(store, 3);
    expect(opsMetrics(store.getState().data!).requests.byStatus).toMatchObject({ requested: 1, assigned: 1 });

    raw.io.engine.close();
    await waitFor(store, "offline", (s) => s.status === "offline");
    await post(live, `/api/ride-requests/${id}/start`); // 4, missed while offline
    raw.connect();
    await atRevision(store, 4);
    expect(opsMetrics(store.getState().data!).trips.byStatus.active).toBe(1);
  });
});
