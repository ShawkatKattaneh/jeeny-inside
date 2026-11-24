/**
 * Phase 3 Prompt 1: the Student App's data layer against a REAL server: Fastify + Socket.IO on a random
 * local port, the real engine, the real REST routes, and the real socket.io-client. The client side
 * is the same realtimeStore, rideApi and studentRides code the app uses. No sleeps: every wait is an
 * event on the store with a bounded timeout.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { io, type Socket } from "socket.io-client";
import { UPDATE_EVENT } from "../../shared/realtime";
import { createBookingController } from "./lib/booking";
import { createRealtimeStore, type RealtimeSocket, type RealtimeStore } from "./lib/realtimeStore";
import { createRideApi } from "./lib/rideApi";
import { studentRides, withPendingRequest } from "./lib/studentRides";
import { cartAt, lineCampus, liveApp, waitFor, type Live } from "./lib/testSupport";

const apps: FastifyInstance[] = [];
const stores: RealtimeStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.stop();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const post = (live: Live, url: string, payload: object = {}) => live.app.inject({ method: "POST", url, payload });

function socketFor(live: Live): Socket {
  return io(live.url, { transports: ["websocket"], forceNew: true, autoConnect: false, reconnection: false });
}

/** A real socket wrapper that silently loses the update with one revision (a missed event). */
function losing(socket: Socket, lostRevision: number): RealtimeSocket & { snapshotRequests: number } {
  const wrapped = new Map<unknown, (...args: unknown[]) => void>();
  const w = {
    snapshotRequests: 0,
    get connected() { return socket.connected; },
    on(event: string, fn: (...args: unknown[]) => void) {
      const g = event === UPDATE_EVENT ? (raw: unknown) => { if ((raw as { revision: number }).revision !== lostRevision) fn(raw); } : fn;
      wrapped.set(fn, g);
      socket.on(event, g);
    },
    off(event: string, fn: (...args: unknown[]) => void) { socket.off(event, wrapped.get(fn) ?? fn); },
    connect: () => socket.connect(),
    disconnect: () => socket.disconnect(),
    timeout(ms: number) { w.snapshotRequests += 1; return socket.timeout(ms); },
  };
  return w;
}

async function connected(live: Live, socket: RealtimeSocket = socketFor(live)) {
  const store = createRealtimeStore({ socket, fetchSnapshot: () => fetch(`${live.url}/api/snapshot`).then((r) => r.json()) });
  stores.push(store);
  store.start();
  await waitFor(store, "the first snapshot", (s) => s.status === "live" && s.data !== null);
  return store;
}

const atRevision = (store: RealtimeStore, rev: number) => waitFor(store, `revision ${rev}`, (s) => s.data?.revision === rev && s.status === "live");

describe("Student App against the real server", () => {
  it("initial snapshot, booking over REST and live updates give the student's own ride, no invented cart", async () => {
    const live = await liveApp(apps, lineCampus(), [cartAt("CART-01", "a")]);
    const store = await connected(live);
    expect(store.getState().data!.campusId).toBe("line");
    expect(studentRides(store.getState().data!, "stu-lina")).toEqual([]);

    const api = createRideApi(live.url);
    const booking = createBookingController({ api, campus: lineCampus(), currentData: () => store.getState().data });
    expect(await booking.submit({ studentId: "stu-lina", pickupId: "c", destinationId: "e" })).toBe("sent");
    await atRevision(store, 1);
    const [ride] = studentRides(store.getState().data!, "stu-lina");
    expect(ride).toMatchObject({ phase: "requested", trip: null, cart: null, synced: true });

    const id = ride!.request.id;
    await post(live, `/api/ride-requests/${id}/dispatch`);
    await atRevision(store, 2);
    expect(studentRides(store.getState().data!, "stu-lina")[0]).toMatchObject({ phase: "assigned", cart: { id: "CART-01" } });
    await post(live, `/api/ride-requests/${id}/start`);
    await post(live, "/api/simulation/advance", { seconds: 600 });
    await atRevision(store, 4);
    expect(studentRides(store.getState().data!, "stu-lina")[0]!.phase).toBe("at_pickup");
    // The client's state equals the server's authoritative snapshot exactly.
    expect(store.getState().data).toEqual((await live.app.inject({ method: "GET", url: "/api/snapshot" })).json());
  });

  it("a missed update (revision gap) is resynchronized from the server's snapshot", async () => {
    const live = await liveApp(apps);
    const socket = losing(socketFor(live), 2);
    const store = await connected(live, socket);
    const created = await post(live, "/api/ride-requests", { studentId: "stu-lina", pickupId: "c", destinationId: "e" });
    const id = created.json().id as string;
    await atRevision(store, 1);
    await post(live, `/api/ride-requests/${id}/dispatch`); // revision 2: lost on the way
    await post(live, `/api/ride-requests/${id}/start`); // revision 3: a gap
    await atRevision(store, 3);
    expect(socket.snapshotRequests).toBe(1);
    expect(store.getState().snapshotSeq).toBe(2);
    expect(studentRides(store.getState().data!, "stu-lina")[0]!.phase).toBe("approaching");
  });

  it("after a dropped connection, reconnecting restores everything that changed meanwhile", async () => {
    const live = await liveApp(apps);
    const raw = socketFor(live);
    const store = await connected(live, raw);
    raw.io.engine.close(); // the transport drops, as on a flaky hotspot
    await waitFor(store, "offline", (s) => s.status === "offline");
    const created = await post(live, "/api/ride-requests", { studentId: "stu-lina", pickupId: "c", destinationId: "e" });
    await post(live, `/api/ride-requests/${created.json().id}/dispatch`);
    expect(store.getState().data!.revision).toBe(0); // nothing arrived while offline
    raw.connect();
    await atRevision(store, 2);
    expect(studentRides(store.getState().data!, "stu-lina")[0]!.phase).toBe("assigned");
  });

  it("two students on separate connections each see only their own ride", async () => {
    const live = await liveApp(apps, lineCampus(), [cartAt("CART-01", "a"), cartAt("CART-02", "e")]);
    const linaStore = await connected(live);
    const omarStore = await connected(live);
    const api = createRideApi(live.url);
    const lina = await api.createRideRequest({ studentId: "stu-lina", pickupId: "a", destinationId: "b" });
    const omar = await api.createRideRequest({ studentId: "stu-omar", pickupId: "d", destinationId: "e" });
    if (!lina.ok || !omar.ok) throw new Error("booking failed");
    await post(live, `/api/ride-requests/${omar.value.id}/dispatch`);
    await atRevision(linaStore, 3);
    await atRevision(omarStore, 3);
    expect(studentRides(linaStore.getState().data!, "stu-lina").map((r) => [r.request.id, r.phase, r.cart])).toEqual([[lina.value.id, "requested", null]]);
    expect(studentRides(omarStore.getState().data!, "stu-omar").map((r) => [r.request.id, r.phase])).toEqual([[omar.value.id, "assigned"]]);
  });

  it("REST and socket in either order: the live state is never overwritten by an older booking response", async () => {
    const live = await liveApp(apps);
    const store = await connected(live);
    const api = createRideApi(live.url);
    const res = await api.createRideRequest({ studentId: "stu-lina", pickupId: "c", destinationId: "e" });
    if (!res.ok) throw new Error(res.message);
    // Socket first, then a newer change, then the (older) REST response is considered.
    await post(live, `/api/ride-requests/${res.value.id}/dispatch`);
    await atRevision(store, 2);
    const s = store.getState();
    const shown = withPendingRequest(studentRides(s.data!, "stu-lina"), { request: res.value, seq: s.snapshotSeq }, s.snapshotSeq, "stu-lina");
    expect(res.value.status).toBe("requested");
    expect(shown.map((r) => [r.phase, r.synced])).toEqual([["assigned", true]]);

    // REST first: a response for a request the live state does not have yet shows as unsynced...
    const before = store.getState();
    const res2 = await api.createRideRequest({ studentId: "stu-omar", pickupId: "a", destinationId: "b" });
    if (!res2.ok) throw new Error(res2.message);
    const pending = { request: res2.value, seq: before.snapshotSeq };
    const early = withPendingRequest(studentRides(before.data!, "stu-omar"), pending, before.snapshotSeq, "stu-omar");
    expect(early.map((r) => [r.phase, r.synced])).toEqual([["requested", false]]);
    // ...and the live version replaces it as soon as the update arrives.
    await atRevision(store, 3);
    const after = store.getState();
    expect(withPendingRequest(studentRides(after.data!, "stu-omar"), pending, after.snapshotSeq, "stu-omar").map((r) => [r.phase, r.synced])).toEqual([["requested", true]]);
  });

  it("cancelling over REST shows Cancelled only once the server's update says so", async () => {
    const live = await liveApp(apps);
    const store = await connected(live);
    const api = createRideApi(live.url);
    const res = await api.createRideRequest({ studentId: "stu-lina", pickupId: "c", destinationId: "e" });
    if (!res.ok) throw new Error(res.message);
    await atRevision(store, 1);
    const cancelled = await api.cancelRide(res.value.id);
    expect(cancelled).toMatchObject({ ok: true, value: { status: "cancelled" } });
    await atRevision(store, 2);
    expect(studentRides(store.getState().data!, "stu-lina")[0]).toMatchObject({ phase: "cancelled", active: false });
    // Cancelling again is refused by the server, with its explanation.
    expect(await api.cancelRide(res.value.id)).toMatchObject({ ok: false, status: 409, code: "RIDE_FINISHED" });
  });
});
