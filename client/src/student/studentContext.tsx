import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { CampusConfig, Persona, RideRequest } from "../../../shared/schemas";
import { createBookingController, type BookingController, type BookingState } from "../lib/booking";
import { useRealtime, useRealtimeStore } from "../lib/realtimeContext";
import type { RealtimeState, RealtimeStore } from "../lib/realtimeStore";
import { createRideApi, type RideApi } from "../lib/rideApi";
import { studentRides, withPendingRequest, type StudentRide } from "../lib/studentRides";

export interface StudentData {
  persona: Persona;
  campus: CampusConfig;
  api: RideApi;
  store: RealtimeStore;
  realtime: RealtimeState;
  booking: BookingController;
  /** This student's rides only, newest first (live state, plus a just-booked request until it syncs). */
  rides: StudentRide[];
  /** The student's newest active ride, if any. */
  activeRide: StudentRide | null;
}

const Ctx = createContext<StudentData | null>(null);
/** Exported so tests can render one screen with a prepared value. */
export const StudentDataContext = Ctx;

/**
 * Shared state for every Student screen: one booking controller and the student's rides derived from
 * the single realtime store. A successful booking is kept only as a fallback until the live state
 * contains it (see withPendingRequest); it never overwrites newer live data.
 */
export function StudentProvider({ persona, campus, api: injectedApi, children }: { persona: Persona; campus: CampusConfig; api?: RideApi; children: ReactNode }) {
  const store = useRealtimeStore();
  const realtime = useRealtime();
  const [api] = useState(() => injectedApi ?? createRideApi());
  const [pending, setPending] = useState<{ request: RideRequest; seq: number } | null>(null);

  const booking = useMemo(
    () =>
      createBookingController({
        api,
        campus,
        currentData: () => store.getState().data,
        onBooked: (request) => {
          const now = store.getState();
          if (now.data?.requests.some((r) => r.id === request.id)) return; // the live state already has it
          setPending({ request, seq: now.snapshotSeq });
          store.resync(); // make sure the live state catches up even if an update was missed
        },
      }),
    [api, campus, store],
  );

  const rides = useMemo(() => {
    const live = realtime.data ? studentRides(realtime.data, persona.id) : [];
    return withPendingRequest(live, pending, realtime.snapshotSeq, persona.id);
  }, [realtime.data, realtime.snapshotSeq, pending, persona.id]);

  const value: StudentData = {
    persona, campus, api, store, realtime, booking, rides,
    activeRide: rides.find((r) => r.active) ?? null,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The Student data when inside the Student area, or null (for shared pieces such as the fare explainer). */
export function useStudentOptional(): StudentData | null {
  return useContext(Ctx);
}

export function useStudent(): StudentData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStudent must be used inside StudentProvider");
  return v;
}

export function useBookingState(booking: BookingController): BookingState {
  return useSyncExternalStore(booking.subscribe, booking.getState, booking.getState);
}

/** How long the first live data may take before the Student screens add a "still connecting" note. */
export const STILL_CONNECTING_MS = 8000;

/**
 * True while no live ride data has arrived yet and at least STILL_CONNECTING_MS have passed. UI hint only:
 * it says nothing about being offline and never implies saved data exists; the realtime store is unchanged.
 */
export function useStillConnecting(ms = STILL_CONNECTING_MS): boolean {
  const { realtime } = useStudent();
  const waiting = realtime.data === null;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [waiting, ms]);
  return waiting && late;
}

/** The note shown under "Loading your rides…" once useStillConnecting() is true. */
export function StillConnectingNote() {
  return useStillConnecting() ? (
    <p className="text-center text-[13px] text-muted" role="status" data-testid="still-connecting">
      Still connecting to live ride updates. Your rides will appear as soon as this device reaches the demo server.
    </p>
  ) : null;
}
