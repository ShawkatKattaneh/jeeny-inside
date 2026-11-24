/**
 * Test-only helpers for the Student App tests (never imported by app code). Server state comes from the
 * real engine and server store, so test payloads are real snapshots and updates, not hand-made objects.
 */
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { CampusConfig, CartInput, StateSnapshot, StateUpdate } from "../../../shared/schemas";
import { createFleet } from "../../../engine/fleet";
import { cartAt, lineCampus } from "../../../engine/testRideFixtures";
import { buildApp } from "../../../server/app";
import { snapshotOf, updateOf } from "../../../server/realtime";
import { createAppStore, type AppStore } from "../../../server/state";
import type { RealtimeSocket, RealtimeState, RealtimeStore } from "./realtimeStore";

export const TIMEOUT_MS = 2000;

export { cartAt, lineCampus };

export function serverStore(campus: CampusConfig = lineCampus(), carts: CartInput[] = [cartAt("CART-01", "a")]): AppStore {
  const fleet = createFleet(campus, carts);
  if (!fleet.ok) throw new Error(fleet.errors.map((e) => e.message).join("; "));
  return createAppStore(campus, fleet.fleet);
}

/** A server store whose commits are recorded as the exact updates the server would broadcast. */
export function recordingStore(campus?: CampusConfig, carts?: CartInput[]) {
  const store = serverStore(campus, carts);
  const updates: StateUpdate[] = [];
  store.onCommit((c) => updates.push(updateOf(c)));
  return { store, updates, snapshot: (): StateSnapshot => store.read(snapshotOf) };
}

export interface Live {
  app: FastifyInstance;
  store: AppStore;
  url: string;
}

export async function liveApp(apps: FastifyInstance[], campus?: CampusConfig, carts?: CartInput[]): Promise<Live> {
  const store = serverStore(campus, carts);
  const app = await buildApp({ store });
  apps.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, store, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

/** Resolve once the store's state matches, or fail after a bounded timeout. Event-driven, no polling. */
export function waitFor(store: RealtimeStore, what: string, matches: (s: RealtimeState) => boolean): Promise<RealtimeState> {
  return new Promise((resolve, reject) => {
    if (matches(store.getState())) return resolve(store.getState());
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`Timed out waiting for ${what}; last state: ${JSON.stringify({ status: store.getState().status, revision: store.getState().data?.revision })}`));
    }, TIMEOUT_MS);
    const stop = store.subscribe(() => {
      if (!matches(store.getState())) return;
      clearTimeout(timer);
      stop();
      resolve(store.getState());
    });
  });
}

type Listener = (...args: unknown[]) => void;

/**
 * An in-memory stand-in for a socket.io-client Socket, for deterministic unit tests of the store's
 * revision rules. The server side is driven by hand: `serverConnect`, `emit`, `answerSnapshotRequest`.
 */
export class FakeSocket implements RealtimeSocket {
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  readonly handlers = new Map<string, Set<Listener>>();
  /** Pending snapshot-request acknowledgements, oldest first. */
  readonly snapshotRequests: ((err: Error | null, value: unknown) => void)[] = [];

  on(event: string, listener: Listener) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(listener);
    return this;
  }
  off(event: string, listener: Listener) {
    this.handlers.get(event)?.delete(listener);
    return this;
  }
  connect() {
    this.connectCalls += 1;
    return this;
  }
  disconnect() {
    this.disconnectCalls += 1;
    if (this.connected) this.serverDisconnect();
    return this;
  }
  timeout(_ms: number) {
    return { emit: (_event: string, ack: (err: Error | null, value: unknown) => void) => this.snapshotRequests.push(ack) };
  }
  listenerCount(): number {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of [...(this.handlers.get(event) ?? [])]) l(...args);
  }
  serverConnect(snapshot: StateSnapshot) {
    this.connected = true;
    this.emit("connect");
    this.emit("state:snapshot", structuredClone(snapshot));
  }
  serverDisconnect() {
    this.connected = false;
    this.emit("disconnect", "transport close");
  }
  answerSnapshotRequest(value: unknown, err: Error | null = null) {
    const ack = this.snapshotRequests.shift();
    if (!ack) throw new Error("No snapshot request is pending");
    ack(err, structuredClone(value));
  }
}

/** In-memory localStorage for rendering persona-gated routes in Node. */
export function memoryStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
