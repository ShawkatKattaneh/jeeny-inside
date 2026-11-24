/**
 * Realtime updates over Socket.IO (Phase 2 Prompt 3).
 *
 * Socket.IO is attached to the Fastify app's own HTTP server (`app.server`): same port, same process,
 * no second server. Sockets are read-only subscribers. REST stays the only way to change state, and
 * the only client event handled here asks for a fresh snapshot.
 *
 * Contract (see README, "Realtime updates"):
 * - On every connection the server first sends "state:snapshot": the whole ride state at its revision.
 * - After each committed operation it sends one "state:update" to every connected socket, carrying the
 *   new revision and every request, trip and cart that operation changed (full objects, after commit).
 * - A client applies an update only if its revision is exactly its own revision + 1, ignores revisions
 *   it already has, and on a gap asks for a fresh snapshot with "state:snapshot:request" (with an
 *   acknowledgement callback) or GET /api/snapshot.
 * Delivery is best effort: Socket.IO does not store or replay missed events. The REST snapshot is
 * always the authority.
 *
 * Why the first snapshot cannot race an update: commits and the connection handler both run
 * synchronously on Node's one thread. The snapshot is read and sent inside the connection handler,
 * after the socket has joined the broadcast; any commit before it is already in the snapshot, any
 * commit after it reaches this socket as an update, in order, behind the snapshot.
 */
import type { FastifyInstance } from "fastify";
import { Server } from "socket.io";
import type { StateSnapshot, StateUpdate } from "../shared/schemas.js";
import { SNAPSHOT_EVENT, SNAPSHOT_REQUEST_EVENT, UPDATE_EVENT } from "../shared/realtime.js";
import type { RideState } from "../engine/rides.js";
import type { AppStore, Commit } from "./state.js";


const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The whole ride state as client-safe plain data, sorted by id. Use through store.read (which copies). */
export function snapshotOf(state: RideState, revision: number): StateSnapshot {
  return {
    revision,
    campusId: state.campus.id,
    clockSeconds: state.clockSeconds,
    requests: [...state.requests.values()].sort(byId),
    trips: [...state.trips.values()].sort(byId),
    carts: [...state.fleet.carts.values()].sort(byId),
  };
}

/** Entries that are new or replaced in `next`. The engine keeps unchanged entities as the same objects. */
function changed<T extends { id: string }>(prev: ReadonlyMap<string, T>, next: ReadonlyMap<string, T>): T[] {
  return [...next.values()].filter((v) => prev.get(v.id) !== v).sort(byId);
}

/** The one update for a commit: what the operation changed, as copied plain data. */
export function updateOf(commit: Commit): StateUpdate {
  const { previous, state } = commit;
  return structuredClone({
    revision: commit.revision,
    operation: commit.operation,
    clockSeconds: state.clockSeconds,
    requests: changed(previous.requests, state.requests),
    trips: changed(previous.trips, state.trips),
    carts: changed(previous.fleet.carts, state.fleet.carts),
  });
}

/**
 * Attach Socket.IO to this app's HTTP server and publish its store's commits. Cleans up when the app
 * closes: stops listening to the store, disconnects every socket and closes the engine before
 * Fastify closes the HTTP server.
 */
export function attachRealtime(app: FastifyInstance, store: AppStore): Server {
  // No CORS options: the demo build serves the app and the socket from one origin, and the dev
  // server proxies /socket.io. This is not access control: anyone who can reach the port can listen.
  const io = new Server(app.server, { serveClient: false });

  io.on("connection", (socket) => {
    socket.emit(SNAPSHOT_EVENT, store.read(snapshotOf));
    socket.on(SNAPSHOT_REQUEST_EVENT, (ack: unknown) => {
      if (typeof ack === "function") ack(store.read(snapshotOf));
    });
  });

  const stop = store.onCommit((commit) => {
    io.emit(UPDATE_EVENT, updateOf(commit));
  });

  app.addHook("preClose", async () => {
    stop();
    io.disconnectSockets(true);
    io.engine.close();
  });
  return io;
}
