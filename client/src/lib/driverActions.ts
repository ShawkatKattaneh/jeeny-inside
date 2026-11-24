/**
 * Sends Driver Mode's lifecycle steps (start, board, drop-off) through the existing REST API, one at a
 * time. It never changes the live state itself: the server's Socket.IO update (or a snapshot) is what
 * moves the screen forward. A success message appears only after the server confirms.
 *
 * - Bound to the exact request and trip id the button was shown for, and re-checked against the latest
 *   live state just before sending; a changed ride is refused locally instead of sent.
 * - While one step is in flight, every other submit is ignored, even if a realtime update already shows
 *   the result (prevents a duplicate send when the socket is faster than the REST answer).
 * - No automatic retries: these operations are not idempotent.
 */
import type { StateSnapshot } from "../../../shared/schemas";
import { ACTION_DONE, bindingStillValid, type ActionBinding } from "./driverWork";
import type { DriverApi } from "./rideApi";

export type DriverActionState =
  | { status: "idle" }
  | { status: "pending"; binding: ActionBinding }
  | { status: "success"; binding: ActionBinding; message: string }
  | { status: "error"; binding: ActionBinding; message: string; code: string };

export interface DriverActionController {
  getState(): DriverActionState;
  subscribe(listener: () => void): () => void;
  submit(binding: ActionBinding): Promise<"sent" | "ignored" | "stale" | "failed">;
  reset(): void;
}

export function createDriverActionController(deps: {
  api: DriverApi;
  /** Latest live state at the moment of submission. */
  currentData: () => StateSnapshot | null;
  /** Ask for a fresh snapshot (used when the update for a confirmed step has not arrived yet). */
  resync: () => void;
}): DriverActionController {
  let state: DriverActionState = { status: "idle" };
  let inFlight = false;
  const listeners = new Set<() => void>();
  const set = (s: DriverActionState) => {
    state = s;
    for (const l of [...listeners]) l();
  };

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    reset() {
      if (!inFlight) set({ status: "idle" });
    },
    async submit(binding) {
      if (inFlight) return "ignored";
      if (!bindingStillValid(deps.currentData(), binding)) {
        set({ status: "error", binding, code: "STALE_STATE", message: "This ride changed since it was shown. Check the latest status and try again." });
        return "stale";
      }
      inFlight = true;
      set({ status: "pending", binding });
      try {
        const res = await deps.api.rideAction(binding.requestId, binding.action);
        if (!res.ok) {
          set({ status: "error", binding, code: res.code, message: res.message });
          return "failed";
        }
        set({ status: "success", binding, message: ACTION_DONE[binding.action] });
        // The response is never written into the live state. If the update has not arrived, resync.
        const live = deps.currentData()?.requests.find((r) => r.id === binding.requestId);
        if (!live || live.status === binding.expectedStatus) deps.resync();
        return "sent";
      } catch {
        set({ status: "error", binding, code: "CLIENT_ERROR", message: "Something went wrong while sending. Check the ride status before trying again." });
        return "failed";
      } finally {
        inFlight = false;
      }
    },
  };
}
