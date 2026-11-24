/**
 * The server's one authoritative application state (Phase 2).
 *
 * The state itself is the engine's immutable RideState. This file only owns the single reference to
 * the current state and the rule for replacing it; every business rule stays in the engine.
 *
 * - Reads hand out deep copies, so nothing a route returns or changes can reach the stored state.
 * - Writes run one engine operation against the current state and replace it only when the
 *   operation succeeds. A failed operation (or one that throws) leaves the previous state in place.
 * - Engine operations are synchronous and `apply` never awaits, so on Node's single thread no other
 *   request can run between reading the current state and replacing it: updates cannot interleave
 *   or be lost, and no lock or queue is needed. Keep it that way: never await inside an operation.
 *
 * Revision: a counter per store, starting at 0, that goes up by exactly 1 each time `apply` replaces
 * the state. Failed operations, operations that throw, and operations that hand back the very same
 * state change nothing and do not move it. `read` sees the state and its revision together.
 *
 * Commit listeners (`onCommit`) run synchronously right after the new state and revision are stored,
 * in commit order. They are told about a commit; they cannot undo it. A listener that throws is
 * logged and ignored, so delivery problems (for example Socket.IO) never roll back a committed state.
 *
 * The state lives in memory only: it is not saved anywhere and starts again from the campus and
 * fleet files whenever the server process restarts.
 *
 * Each buildApp call creates its own store, so tests get isolated instances; production startup
 * (server/index.ts) calls buildApp once, so normal operation has exactly one store.
 */
import type { CampusConfig, StateOperation } from "../shared/schemas.js";
import type { Fleet } from "../engine/fleet.js";
import { createRideState, type RideState } from "../engine/rides.js";

/** What an engine operation returns: a new state plus extra fields, or an error (RideResult's shape). */
export type OperationResult = { ok: true; state: RideState } | { ok: false; error: object };

/** The result of a write: the operation's own fields (copied), with the internal state removed. */
export type ApplyResult<R> = R extends { ok: true; state: RideState } ? Omit<R, "state"> : R;

/** A committed state change, as told to commit listeners (server-internal; never sent as is). */
export interface Commit {
  revision: number;
  operation: StateOperation;
  previous: RideState;
  state: RideState;
}

export interface AppStore {
  /** Run a read-only selector on the current state (and its revision) and return a deep copy of what it selects. */
  read<T>(select: (state: RideState, revision: number) => T): T;
  /**
   * Run one engine operation; the stored state is replaced only if it succeeds, and then the
   * revision goes up by 1 and commit listeners run. `operation` names the change for listeners.
   */
  apply<R extends OperationResult>(op: (state: RideState) => R, operation?: StateOperation): ApplyResult<R>;
  /** Be told about every later commit, in order. Returns a function that stops it. */
  onCommit(listener: (commit: Commit) => void): () => void;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * Build the initial ride state with the engine's own checks and wrap it in a store. Throws a readable
 * error if the engine refuses the campus and fleet; it never substitutes an empty or default state.
 * The campus is copied and deep-frozen first, so the caller's object is untouched and the stored
 * campus cannot be changed through any reference.
 */
export function createAppStore(campus: CampusConfig, fleet: Fleet): AppStore {
  const created = createRideState(deepFreeze(structuredClone(campus)), fleet);
  if (!created.ok) throw new Error(`Could not start the ride engine: ${created.error.message}`);
  let current: RideState = created.state;
  let revision = 0;
  const listeners = new Set<(commit: Commit) => void>();

  return Object.freeze({
    read<T>(select: (state: RideState, revision: number) => T): T {
      return structuredClone(select(current, revision));
    },
    apply<R extends OperationResult>(op: (state: RideState) => R, operation: StateOperation = "state.changed"): ApplyResult<R> {
      const result = op(current);
      if (!result.ok) return { ok: false, error: structuredClone(result.error) } as ApplyResult<R>;
      const { ok: _ok, state: next, ...extra } = result as { ok: true; state: RideState };
      const reply = { ok: true, ...structuredClone(extra) } as ApplyResult<R>;
      if (next === current) return reply; // no change: no new revision, nothing to tell
      const previous = current;
      current = next;
      revision += 1;
      const commit: Commit = { revision, operation, previous, state: next };
      for (const listener of [...listeners]) {
        try {
          listener(commit);
        } catch (err) {
          console.error(`[state] a commit listener failed at revision ${revision}; the state stays committed:`, err);
        }
      }
      return reply;
    },
    onCommit(listener: (commit: Commit) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}
