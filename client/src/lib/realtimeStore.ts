/**
 * The client's one realtime subscription (Phase 3).
 *
 * Holds the latest authoritative ride state received from the server (StateSnapshot shape) and keeps
 * it in step with the Socket.IO contract in shared/realtime.ts:
 * - "state:snapshot" on every (re)connection replaces everything (a reconnect may even be a restarted
 *   server whose revision starts again at 0).
 * - "state:update" is applied only when classifyRevision says "apply". "stale" (duplicates, old
 *   revisions) is ignored. "gap" is never applied: the store asks for a fresh snapshot instead.
 * - A requested snapshot (socket acknowledgement, or GET /api/snapshot as a fallback) is accepted only
 *   if it is not older than the revision already held, so a slow reply cannot roll the state back.
 * - Payloads are checked with the shared schemas; an invalid one is treated like a gap.
 *
 * Nothing here writes REST responses into the state: only the server's snapshots and updates do.
 * The store is plain TypeScript (no React), so it is tested against a real Socket.IO server in Node.
 * Delivery is best effort; the snapshot is always the authority.
 */
import { StateSnapshot, StateUpdate } from "../../../shared/schemas";
import { SNAPSHOT_EVENT, SNAPSHOT_REQUEST_EVENT, UPDATE_EVENT, classifyRevision } from "../../../shared/realtime";

/** The part of a socket.io-client Socket this store uses (a real Socket satisfies it). */
/* Listener arguments arrive untyped from the network; every payload is checked with Zod before use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

export interface RealtimeSocket {
  readonly connected: boolean;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  connect(): unknown;
  disconnect(): unknown;
  timeout(ms: number): { emit(event: string, ack: (err: Error | null, value: unknown) => void): unknown };
}

/**
 * - connecting: no snapshot on the current connection yet.
 * - live:       connected and in step with the server.
 * - resyncing:  a revision gap (or invalid payload) was seen; a fresh snapshot has been asked for.
 * - offline:    disconnected; `data` is the last known state and may be out of date.
 */
export type RealtimeStatus = "connecting" | "live" | "resyncing" | "offline";

export interface RealtimeState {
  status: RealtimeStatus;
  /** The latest authoritative state, or null before the first snapshot. */
  data: StateSnapshot | null;
  /** Goes up by 1 every time a snapshot replaces the state (connection, acknowledgement or REST). */
  snapshotSeq: number;
}

export interface RealtimeStore {
  getState(): RealtimeState;
  subscribe(listener: () => void): () => void;
  /** Attach listeners and connect. Calling it again while started does nothing. */
  start(): void;
  /** Remove every listener this store added and disconnect. The store can be started again. */
  stop(): void;
  /** Ask the server for a fresh authoritative snapshot (no-op while one is already on its way). */
  resync(): void;
}

export interface RealtimeStoreOptions {
  socket: RealtimeSocket;
  /** Fallback when the socket cannot answer a snapshot request. Defaults to GET /api/snapshot. */
  fetchSnapshot?: () => Promise<unknown>;
  /** How long to wait for the socket's snapshot acknowledgement before using the fallback. */
  ackTimeoutMs?: number;
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Replace or add each changed entity by id, keeping the server's id order. */
function merge<T extends { id: string }>(current: T[], changed: T[]): T[] {
  if (changed.length === 0) return current;
  const map = new Map(current.map((x) => [x.id, x]));
  for (const c of changed) map.set(c.id, c);
  return [...map.values()].sort(byId);
}

export function applyUpdate(data: StateSnapshot, update: StateUpdate): StateSnapshot {
  return {
    ...data,
    revision: update.revision,
    clockSeconds: update.clockSeconds,
    requests: merge(data.requests, update.requests),
    trips: merge(data.trips, update.trips),
    carts: merge(data.carts, update.carts),
  };
}

const defaultFetchSnapshot = async (): Promise<unknown> => {
  const res = await fetch("/api/snapshot");
  if (!res.ok) throw new Error(`/api/snapshot answered ${res.status}`);
  return res.json();
};

export function createRealtimeStore({ socket, fetchSnapshot = defaultFetchSnapshot, ackTimeoutMs = 3000 }: RealtimeStoreOptions): RealtimeStore {
  let state: RealtimeState = { status: "connecting", data: null, snapshotSeq: 0 };
  const listeners = new Set<() => void>();
  let started = false;
  let resyncing = false;
  /** Bumped on stop and on every connection, so replies meant for an older one are dropped. */
  let generation = 0;

  function set(next: Partial<RealtimeState>) {
    state = { ...state, ...next };
    for (const l of [...listeners]) l();
  }

  const settledStatus = (): RealtimeStatus => (socket.connected ? "live" : "offline");

  function acceptSnapshot(raw: unknown, source: "connection" | "requested"): boolean {
    const parsed = StateSnapshot.safeParse(raw);
    if (!parsed.success) return false;
    const held = state.data?.revision;
    // A requested snapshot older than what we hold is a slow reply: keep the newer state.
    if (source === "requested" && held !== undefined && parsed.data.revision < held) return true;
    set({ data: parsed.data, snapshotSeq: state.snapshotSeq + 1, status: settledStatus() });
    return true;
  }

  function resync() {
    if (!started || resyncing) return;
    resyncing = true;
    const gen = generation;
    set({ status: socket.connected ? "resyncing" : "offline" });
    const finish = (ok: boolean) => {
      if (gen !== generation) return;
      resyncing = false;
      // On failure keep the last state; the next gap, update or reconnection tries again.
      set({ status: ok ? settledStatus() : socket.connected ? "resyncing" : "offline" });
    };
    const viaRest = () =>
      fetchSnapshot().then(
        (raw) => gen === generation && finish(acceptSnapshot(raw, "requested")),
        () => finish(false),
      );
    socket.timeout(ackTimeoutMs).emit(SNAPSHOT_REQUEST_EVENT, (err, raw) => {
      if (gen !== generation) return;
      if (!err && acceptSnapshot(raw, "requested")) return finish(true);
      void viaRest();
    });
  }

  const onSnapshot = (raw: unknown) => {
    // A connection snapshot is authoritative: it replaces everything, whatever its revision.
    if (!acceptSnapshot(raw, "connection")) resync();
  };

  const onUpdate = (raw: unknown) => {
    const parsed = StateUpdate.safeParse(raw);
    if (!parsed.success || !state.data) return resync();
    const verdict = classifyRevision(state.data.revision, parsed.data.revision);
    if (verdict === "stale") return;
    if (verdict === "gap") return resync();
    set({ data: applyUpdate(state.data, parsed.data), status: resyncing ? "resyncing" : settledStatus() });
  };

  const onConnect = () => {
    generation += 1; // replies to requests made on the previous connection no longer count
    resyncing = false;
    set({ status: "connecting" });
  };

  const onDisconnect = () => {
    set({ status: "offline" });
  };

  const handlers: [string, Listener][] = [
    [SNAPSHOT_EVENT, onSnapshot],
    [UPDATE_EVENT, onUpdate],
    ["connect", onConnect],
    ["disconnect", onDisconnect],
  ];

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started) return;
      started = true;
      for (const [event, fn] of handlers) socket.on(event, fn);
      set({ status: socket.connected ? state.status : "connecting" });
      socket.connect();
    },
    stop() {
      if (!started) return;
      started = false;
      generation += 1;
      resyncing = false;
      for (const [event, fn] of handlers) socket.off(event, fn);
      socket.disconnect();
      set({ status: "offline" });
    },
    resync,
  };
}
