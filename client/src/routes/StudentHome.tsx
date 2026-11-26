import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Persona } from "../../../shared/schemas";
import { useCampus } from "../lib/campusContext";
import { RealtimeProvider } from "../lib/realtimeContext";
import type { RealtimeStore } from "../lib/realtimeStore";
import type { RideApi } from "../lib/rideApi";
import { HomeView } from "../student/HomeView";
import { LiveStatus } from "../student/LiveStatus";
import { RideDetailView } from "../student/RideDetailView";
import { RidesView } from "../student/RidesView";
import { StudentProvider, useStudent } from "../student/studentContext";
import { AreaLayout } from "./AreaLayout";

/**
 * The Student App (/student, /student/rides, /student/rides/:requestId). One realtime connection for
 * the whole area, opened when a student persona enters it and closed when they leave.
 * `store` and `api` are for tests; the app uses the real socket and REST API.
 */
export function StudentHome({ store, api }: { store?: RealtimeStore; api?: RideApi } = {}) {
  return <AreaLayout role="student" wide>{(p) => <StudentArea persona={p} store={store} api={api} />}</AreaLayout>;
}

function StudentArea({ persona, store, api }: { persona: Persona; store?: RealtimeStore; api?: RideApi }) {
  const campus = useCampus();
  return (
    <RealtimeProvider store={store}>
      <StudentProvider persona={persona} campus={campus} api={api}>
        <StudentNav />
        <Routes>
          <Route index element={<HomeView />} />
          <Route path="rides" element={<RidesView />} />
          <Route path="rides/:requestId" element={<RideDetailView />} />
          <Route path="*" element={<Navigate to="/student" replace />} />
        </Routes>
      </StudentProvider>
    </RealtimeProvider>
  );
}

function StudentNav() {
  const { realtime, activeRide } = useStudent();
  const tab = ({ isActive }: { isActive: boolean }) =>
    `inline-flex min-h-11 items-center rounded-full px-4 py-2 text-sm font-semibold transition ${isActive ? "bg-ink text-white" : "text-ink ring-1 ring-line"}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <nav aria-label="Student" className="flex gap-2">
        <NavLink to="/student" end className={tab}>
          Home
        </NavLink>
        <NavLink to="/student/rides" className={tab}>
          Your rides
          {activeRide && <><span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-brand align-middle" aria-hidden="true" /><span className="sr-only"> (active ride)</span></>}
        </NavLink>
      </nav>
      <LiveStatus status={realtime.status} />
    </div>
  );
}
