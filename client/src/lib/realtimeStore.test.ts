/**
 * Phase 3 Prompt 1: the Student App's realtime store, driven deterministically through an in-memory
 * socket. Every snapshot and update here was produced by the real engine and server store (see
 * recordingStore), so the payloads are exactly what the server broadcasts. The same store is also
 * tested against a real Socket.IO server in client/src/student.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { createRequest, startTrip } from "../../../engine/rides";
import { dispatchRequest } from "../../../engine/dispatch";
import { createRealtimeStore } from "./realtimeStore";
import { FakeSocket, recordingStore } from "./testSupport";

/** A real server store and its snapshot at revision 0. */
function serverWithHistory() {
  const rec = recordingStore();
  return { rec, at0: rec.snapshot() };
}

/** Through the real engine: create a ride (revision 1), dispatch it (2), start it (3). */
function runRide(rec: ReturnType<typeof recordingStore>) {
  const r = rec.store.apply((s) => createRequest(s, { studentId: "stu-lina", pickupId: "c", destinationId: "e" }), "ride_request.created");
  if (!r.ok) throw new Error("create failed");
  const id = r.request.id;
  rec.store.apply((s) => dispatchRequest(s, id), "ride.dispatched");
  rec.store.apply((s) => startTrip(s, id), "ride.started");
  return id;
}

function started(fetchSnapshot?: () => Promise<unknown>) {
  const socket = new FakeSocket();
  const store = createRealtimeStore({ socket, fetchSnapshot: fetchSnapshot ?? (() => Promise.reject(new Error("no REST in this test"))) });
  store.start();
  return { socket, store };
}

describe("realtime store: snapshots and revisions", () => {
  it("the connection snapshot populates the state and marks it live", () => {
    const { at0 } = serverWithHistory();
    const { socket, store } = started();
    expect(store.getState()).toMatchObject({ status: "connecting", data: null });
    socket.serverConnect(at0);
    expect(store.getState()).toMatchObject({ status: "live", snapshotSeq: 1, data: at0 });
  });

  it("applies the next revisions in order and lands on exactly the server's state", async () => {
    const { rec, at0 } = serverWithHistory();
    const { socket, store } = started();
    socket.serverConnect(at0);
    runRide(rec);
    expect(rec.updates.map((u) => u.revision)).toEqual([1, 2, 3]);
    for (const u of rec.updates) socket.emit("state:update", structuredClone(u));
    expect(store.getState().data).toEqual(rec.snapshot());
    expect(store.getState().data!.requests[0]!.status).toBe("arriving");
    expect(socket.snapshotRequests).toHaveLength(0);
  });

  it("ignores duplicate and stale revisions without notifying or changing anything", async () => {
    const { rec, at0 } = serverWithHistory();
    const { socket, store } = started();
    socket.serverConnect(at0);
    runRide(rec);
    const [u1, u2] = rec.updates;
    socket.emit("state:update", structuredClone(u1));
    socket.emit("state:update", structuredClone(u2));
    const before = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);
    socket.emit("state:update", structuredClone(u2)); // duplicate
    socket.emit("state:update", structuredClone(u1)); // older
    expect(store.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(socket.snapshotRequests).toHaveLength(0);
  });

  it("a revision gap is never applied: the store asks for a snapshot and adopts it", async () => {
    const { rec, at0 } = serverWithHistory();
    const { socket, store } = started();
    socket.serverConnect(at0);
    runRide(rec);
    const [u1, , u3] = rec.updates;
    socket.emit("state:update", structuredClone(u1));
    socket.emit("state:update", structuredClone(u3)); // revision 2 was missed
    expect(store.getState().data!.revision).toBe(1);
    expect(store.getState().status).toBe("resyncing");
    expect(socket.snapshotRequests).toHaveLength(1);
    // A second gap while the request is pending does not send another request.
    socket.emit("state:update", structuredClone(u3));
    expect(socket.snapshotRequests).toHaveLength(1);
    socket.answerSnapshotRequest(rec.snapshot());
    expect(store.getState()).toMatchObject({ status: "live", data: rec.snapshot(), snapshotSeq: 2 });
  });

  it("a requested snapshot older than the state already held is ignored (slow reply)", async () => {
    const { rec, at0 } = serverWithHistory();
    const { socket, store } = started();
    socket.serverConnect(at0);
    runRide(rec);
    const [u1, u2, u3] = rec.updates;
    socket.emit("state:update", structuredClone(u1));
    socket.emit("state:update", structuredClone(u3)); // gap -> request
    socket.emit("state:update", structuredClone(u2)); // the missing one arrives late
    socket.emit("state:update", structuredClone(u3)); // now applies
    expect(store.getState().data!.revision).toBe(3);
    socket.answerSnapshotRequest(at0); // reply carries revision 0
    expect(store.getState().data!.revision).toBe(3);
    expect(store.getState().status).toBe("live");
  });

  it("falls back to GET /api/snapshot when the socket acknowledgement fails", async () => {
    const { rec, at0 } = serverWithHistory();
    runRide(rec);
    const fetchSnapshot = vi.fn(async () => rec.snapshot());
    const { socket, store } = started(fetchSnapshot);
    socket.serverConnect(at0);
    socket.emit("state:update", structuredClone(rec.updates[2])); // gap
    socket.answerSnapshotRequest(null, new Error("operation has timed out"));
    await vi.waitFor(() => expect(store.getState().data!.revision).toBe(3));
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe("live");
  });

  it("an invalid update payload is treated like a gap", () => {
    const { at0 } = serverWithHistory();
    const { socket, store } = started();
    socket.serverConnect(at0);
    socket.emit("state:update", { revision: 1, operation: "made-up" });
    expect(store.getState().data).toEqual(at0);
    expect(socket.snapshotRequests).toHaveLength(1);
  });
});

describe("realtime store: connection lifecycle", () => {
  it("disconnect keeps the last state (marked offline); reconnect replaces it with the new snapshot", async () => {
    const { rec, at0 } = serverWithHistory();
    const { socket, store } = started();
    socket.serverConnect(at0);
    socket.serverDisconnect();
    expect(store.getState()).toMatchObject({ status: "offline", data: at0 });
    runRide(rec); // changes while offline
    socket.serverConnect(rec.snapshot());
    expect(store.getState()).toMatchObject({ status: "live", data: rec.snapshot(), snapshotSeq: 2 });
  });

  it("a reconnection snapshot with a LOWER revision (restarted server) still replaces the state", async () => {
    const { rec, at0 } = serverWithHistory();
    runRide(rec);
    const { socket, store } = started();
    socket.serverConnect(rec.snapshot());
    socket.serverDisconnect();
    socket.serverConnect(at0);
    expect(store.getState().data).toEqual(at0);
  });

  it("a snapshot reply meant for the previous connection is dropped", async () => {
    const { rec, at0 } = serverWithHistory();
    runRide(rec);
    const { socket, store } = started();
    socket.serverConnect(at0);
    socket.emit("state:update", structuredClone(rec.updates[2])); // gap -> request on connection 1
    socket.serverDisconnect();
    socket.serverConnect(at0); // connection 2
    socket.answerSnapshotRequest(rec.snapshot()); // late answer from connection 1
    expect(store.getState().data).toEqual(at0);
  });

  it("start is idempotent, and stop removes every listener and disconnects", () => {
    const { socket, store } = started();
    const n = socket.listenerCount();
    expect(n).toBe(4);
    store.start();
    expect(socket.listenerCount()).toBe(n);
    expect(socket.connectCalls).toBe(1);
    store.stop();
    expect(socket.listenerCount()).toBe(0);
    expect(socket.disconnectCalls).toBe(1);
    // Restartable (React StrictMode mounts effects twice in development).
    store.start();
    expect(socket.listenerCount()).toBe(n);
    expect(socket.connectCalls).toBe(2);
  });

  it("after stop, events and replies no longer change the state", () => {
    const { at0 } = serverWithHistory();
    const { socket, store } = started();
    socket.serverConnect(at0);
    socket.emit("state:update", { bad: true }); // pending snapshot request
    store.stop();
    const before = store.getState();
    socket.answerSnapshotRequest({ ...at0, revision: 9 });
    socket.emit("state:snapshot", { ...at0, revision: 9 });
    expect(store.getState()).toBe(before);
  });
});

describe("reconnecting after the server closes the connection", () => {
  it("a server-side disconnect (clean server restart) asks the socket to reconnect once, after a pause", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
      store.start();
      socket.serverConnect(recordingStore().snapshot());
      const before = socket.connectCalls;
      socket.connected = false;
      socket.emit("disconnect", "io server disconnect");
      expect(store.getState().status).toBe("offline");
      vi.advanceTimersByTime(999);
      expect(socket.connectCalls).toBe(before);
      vi.advanceTimersByTime(1);
      expect(socket.connectCalls).toBe(before + 1);
      // A second server disconnect while the first retry is pending does not stack retries.
      socket.emit("disconnect", "io server disconnect");
      socket.emit("disconnect", "io server disconnect");
      vi.advanceTimersByTime(1000);
      expect(socket.connectCalls).toBe(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an ordinary transport drop leaves reconnecting to socket.io, and stop() cancels a pending retry", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const store = createRealtimeStore({ socket, fetchSnapshot: () => Promise.reject(new Error("unused")) });
      store.start();
      socket.serverConnect(recordingStore().snapshot());
      const before = socket.connectCalls;
      socket.serverDisconnect(); // "transport close": socket.io-client retries by itself
      vi.advanceTimersByTime(5000);
      expect(socket.connectCalls).toBe(before);
      socket.serverConnect(recordingStore().snapshot());
      socket.connected = false;
      socket.emit("disconnect", "io server disconnect");
      store.stop();
      vi.advanceTimersByTime(5000);
      expect(socket.connectCalls).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
