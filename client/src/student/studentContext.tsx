import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
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

export function useStudent(): StudentData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStudent must be used inside StudentProvider");
  return v;
}

export function useBookingState(booking: BookingController): BookingState {
  return useSyncExternalStore(booking.subscribe, booking.getState, booking.getState);
}
