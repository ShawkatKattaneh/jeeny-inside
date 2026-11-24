/**
 * The Operations Dashboard's two controls (Phase 3 Prompt 3): dispatch one request, and advance the
 * simulation clock. Both go through the existing REST API, one call at a time each, never retried.
 * Neither writes its REST answer into the live state: the server's Socket.IO update (or a snapshot)
 * changes the dashboard. When the answer arrives before the update, the store is asked to resync.
 */
import { AdvanceSimulationBody, type StateSnapshot } from "../../../shared/schemas";
import type { DispatchResult, DispatchSelection, OpsApi } from "./rideApi";

type Listeners = Set<() => void>;
function emitter<S>(initial: S) {
  let state = initial;
  const listeners: Listeners = new Set();
  return {
    get: () => state,
    set: (s: S) => {
      state = s;
      for (const l of [...listeners]) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

// ---------- Dispatch ----------

export type DispatchState =
  | { status: "idle" }
  | { status: "pending"; requestId: string }
  | { status: "success"; requestId: string; result: DispatchResult }
  | { status: "error"; requestId: string; code: string; message: string; selection?: DispatchSelection };

export interface DispatchController {
  getState(): DispatchState;
  subscribe(listener: () => void): () => void;
  submit(requestId: string): Promise<"sent" | "ignored" | "stale" | "failed">;
  reset(): void;
}

export function createDispatchController(deps: { api: OpsApi; currentData: () => StateSnapshot | null; resync: () => void }): DispatchController {
  const s = emitter<DispatchState>({ status: "idle" });
  let inFlight = false;
  return {
    getState: s.get,
    subscribe: s.subscribe,
    reset() {
      if (!inFlight) s.set({ status: "idle" });
    },
    async submit(requestId) {
      if (inFlight) return "ignored";
      const live = deps.currentData()?.requests.find((r) => r.id === requestId);
      if (!live || live.status !== "requested") {
        s.set({ status: "error", requestId, code: "STALE_STATE", message: live ? `${requestId} is ${live.status} now; only a requested ride can be dispatched.` : `${requestId} is not in the live state.` });
        return "stale";
      }
      inFlight = true;
      s.set({ status: "pending", requestId });
      try {
        const res = await deps.api.dispatch(requestId);
        if (!res.ok) {
          s.set({ status: "error", requestId, code: res.code, message: res.message, ...(res.selection ? { selection: res.selection } : {}) });
          return "failed";
        }
        s.set({ status: "success", requestId, result: res.value });
        if (deps.currentData()?.requests.find((r) => r.id === requestId)?.status === "requested") deps.resync();
        return "sent";
      } catch {
        s.set({ status: "error", requestId, code: "CLIENT_ERROR", message: "Something went wrong while dispatching. Check the request's status before trying again." });
        return "failed";
      } finally {
        inFlight = false;
      }
    },
  };
}

// ---------- Simulation ----------

export type AdvanceState =
  | { status: "idle" }
  | { status: "pending"; seconds: number }
  /** clockSeconds is the server's confirmed clock from its answer. */
  | { status: "success"; seconds: number; clockSeconds: number }
  | { status: "error"; seconds: number | null; code: string; message: string };

export interface AdvanceController {
  getState(): AdvanceState;
  subscribe(listener: () => void): () => void;
  submit(seconds: unknown): Promise<"sent" | "ignored" | "invalid" | "failed">;
  reset(): void;
}

/** Same rules the server applies (shared AdvanceSimulationBody: 0 < seconds <= MAX_SIMULATION_STEP_SECONDS). */
export function checkAdvanceSeconds(seconds: unknown): { ok: true; seconds: number } | { ok: false; message: string } {
  const r = AdvanceSimulationBody.safeParse({ seconds });
  if (r.success) return { ok: true, seconds: r.data.seconds };
  return { ok: false, message: r.error.issues.map((i) => i.message).join("; ") };
}

export function createAdvanceController(deps: { api: OpsApi; currentData: () => StateSnapshot | null; resync: () => void }): AdvanceController {
  const s = emitter<AdvanceState>({ status: "idle" });
  let inFlight = false;
  return {
    getState: s.get,
    subscribe: s.subscribe,
    reset() {
      if (!inFlight) s.set({ status: "idle" });
    },
    async submit(raw) {
      if (inFlight) return "ignored";
      const check = checkAdvanceSeconds(raw);
      if (!check.ok) {
        s.set({ status: "error", seconds: null, code: "INVALID_REQUEST", message: check.message });
        return "invalid";
      }
      inFlight = true;
      s.set({ status: "pending", seconds: check.seconds });
      try {
        const res = await deps.api.advance({ seconds: check.seconds });
        if (!res.ok) {
          s.set({ status: "error", seconds: check.seconds, code: res.code, message: res.message });
          return "failed";
        }
        s.set({ status: "success", seconds: check.seconds, clockSeconds: res.value.clockSeconds });
        const held = deps.currentData()?.clockSeconds;
        if (held === undefined || held < res.value.clockSeconds) deps.resync();
        return "sent";
      } catch {
        s.set({ status: "error", seconds: check.seconds, code: "CLIENT_ERROR", message: "Something went wrong while advancing. Check the simulation clock before trying again." });
        return "failed";
      } finally {
        inFlight = false;
      }
    },
  };
}
