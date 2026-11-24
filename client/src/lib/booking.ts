/**
 * Booking a ride from the Student App: input checks before the request is sent, and one controller
 * that sends it at most once at a time. The server (engine createRequest) stays the authority: these
 * checks only stop selections the server would refuse anyway and stale forms, never replace its rules.
 */
import type { CampusConfig, Location, RideRequest, StateSnapshot } from "../../../shared/schemas";
import type { RideApi } from "./rideApi";
import { isActiveStatus } from "./studentRides";

/** Locations where a cart may stop, straight from the campus file (Location.canStop). */
export const stopLocations = (campus: CampusConfig): Location[] => campus.locations.filter((l) => l.canStop);

export type SelectionCheck = { ok: true } | { ok: false; field: "pickupId" | "destinationId"; message: string };

export function checkSelection(campus: CampusConfig, pickupId: string, destinationId: string): SelectionCheck {
  const stops = new Set(stopLocations(campus).map((l) => l.id));
  if (!pickupId) return { ok: false, field: "pickupId", message: "Choose a pickup location." };
  if (!stops.has(pickupId)) return { ok: false, field: "pickupId", message: "That pickup is not a stop on this campus. Choose another." };
  if (!destinationId) return { ok: false, field: "destinationId", message: "Choose a destination." };
  if (!stops.has(destinationId)) return { ok: false, field: "destinationId", message: "That destination is not a stop on this campus. Choose another." };
  if (pickupId === destinationId) return { ok: false, field: "destinationId", message: "Pickup and destination must be different." };
  return { ok: true };
}

/**
 * Why booking is not possible right now, from the latest live state, or null. Checked again at the
 * moment of submission, so a form opened earlier cannot send against a changed state.
 * The one-active-ride limit is a Student App presentation choice to avoid accidental duplicates; the
 * server does not enforce it.
 */
export function bookingBlockReason(campus: CampusConfig, data: StateSnapshot | null, studentId: string): string | null {
  if (!data) return "Connecting to live ride updates…";
  if (data.campusId !== campus.id) return "The server is now running a different campus. Reload the page to continue.";
  if (data.requests.some((r) => r.studentId === studentId && isActiveStatus(r.status))) return "You already have an active ride. Follow it below.";
  return null;
}

export type BookingState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; request: RideRequest }
  | { status: "error"; message: string; code: string };

export interface BookingInput {
  studentId: string;
  pickupId: string;
  destinationId: string;
  /**
   * Phase 4: "shared" asks the server to consider combining this ride with compatible ones. Solo is the
   * default: a solo booking (mode omitted or "solo") sends exactly the pre-Phase-4 body, with no mode
   * field, because the server already treats a missing mode as solo. Choosing shared never guarantees
   * a match; only the server's dispatch decides.
   */
  mode?: "solo" | "shared";
}

export interface BookingController {
  getState(): BookingState;
  subscribe(listener: () => void): () => void;
  /**
   * Validate and send one ride request. While one is in flight, further calls are ignored and resolve
   * to "ignored", so repeated taps cannot create duplicate requests.
   */
  submit(input: BookingInput): Promise<"sent" | "ignored" | "invalid" | "blocked" | "failed">;
  reset(): void;
}

export function createBookingController(deps: {
  api: RideApi;
  campus: CampusConfig;
  /** Latest live state at the moment of submission. */
  currentData: () => StateSnapshot | null;
  /** Told about a successful booking, with the server's request (never a client-made one). */
  onBooked?: (request: RideRequest) => void;
}): BookingController {
  let state: BookingState = { status: "idle" };
  let inFlight = false;
  const listeners = new Set<() => void>();
  const set = (s: BookingState) => {
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
    async submit(input) {
      if (inFlight) return "ignored";
      const check = checkSelection(deps.campus, input.pickupId, input.destinationId);
      if (!check.ok) {
        set({ status: "error", message: check.message, code: "INVALID_SELECTION" });
        return "invalid";
      }
      const blocked = bookingBlockReason(deps.campus, deps.currentData(), input.studentId);
      if (blocked) {
        set({ status: "error", message: blocked, code: "BLOCKED" });
        return "blocked";
      }
      inFlight = true;
      set({ status: "submitting" });
      try {
        const res = await deps.api.createRideRequest({
          studentId: input.studentId,
          pickupId: input.pickupId,
          destinationId: input.destinationId,
          ...(input.mode === "shared" ? { mode: "shared" as const } : {}),
        });
        if (!res.ok) {
          set({ status: "error", message: res.message, code: res.code });
          return "failed";
        }
        set({ status: "success", request: res.value });
        deps.onBooked?.(res.value);
        return "sent";
      } catch {
        set({ status: "error", message: "Something went wrong while requesting the ride. Try again.", code: "CLIENT_ERROR" });
        return "failed";
      } finally {
        inFlight = false;
      }
    },
  };
}
