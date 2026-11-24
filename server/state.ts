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
 * Each buildApp call creates its own store, so tests get isolated instances; production startup
 * (server/index.ts) calls buildApp once, so normal operation has exactly one store.
 */
import type { CampusConfig } from "../shared/schemas.js";
import type { Fleet } from "../engine/fleet.js";
import { createRideState, type RideError, type RideResult, type RideState } from "../engine/rides.js";

/** The result of a write: the operation's own extra fields (copied), never the internal state. */
export type ApplyResult<T extends object> = ({ ok: true } & T) | { ok: false; error: RideError };

export interface AppStore {
  /** Run a read-only selector on the current state and return a deep copy of what it selects. */
  read<T>(select: (state: RideState) => T): T;
  /** Run one engine operation; the stored state is replaced only if it succeeds. */
  apply<T extends object>(op: (state: RideState) => RideResult<T>): ApplyResult<T>;
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

  return Object.freeze({
    read<T>(select: (state: RideState) => T): T {
      return structuredClone(select(current));
    },
    apply<T extends object>(op: (state: RideState) => RideResult<T>): ApplyResult<T> {
      const result = op(current);
      if (!result.ok) return { ok: false, error: { ...result.error } };
      current = result.state;
      const { ok: _ok, state: _internal, ...extra } = result;
      return { ok: true, ...structuredClone(extra) } as ApplyResult<T>;
    },
  });
}
