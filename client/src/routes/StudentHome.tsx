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
import { HomeIcon, RidesIcon } from "../ui/icons";
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
        <div className="flex flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))]">
          <Routes>
            <Route index element={<HomeView />} />
            <Route path="rides" element={<RidesView />} />
            <Route path="rides/:requestId" element={<RideDetailView />} />
            <Route path="*" element={<Navigate to="/student" replace />} />
          </Routes>
        </div>
        <StudentNav />
      </StudentProvider>
    </RealtimeProvider>
  );
}

/** Live connection chip, shown in each Student screen's header area (on the map on Home). */
export function StudentLive({ className = "" }: { className?: string }) {
  const { realtime } = useStudent();
  return <span className={className}><LiveStatus status={realtime.status} /></span>;
}

/**
 * Student navigation. The approved direction is five tabs (Home, Quick, My Rides, Campus Map, Profile);
 * only the destinations that exist are shown, so there are no dead links. Quick, Campus Map and Profile
 * are added here when their screens are built. Always a bottom tab bar, kept inside the phone column.
 */
function StudentNav() {
  const { activeRide } = useStudent();
  const tab = ({ isActive }: { isActive: boolean }) =>
    `relative flex flex-1 flex-col items-center justify-center gap-0.5 px-2 text-[13px] transition-colors duration-150 ${isActive ? "font-bold text-brand-strong before:absolute before:inset-x-8 before:top-0 before:h-[3px] before:rounded-b-full before:bg-brand before:content-['']" : "font-semibold text-muted hover:text-ink"}`;
  return (
    <nav
      aria-label="Student"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto flex h-[calc(3.5rem+env(safe-area-inset-bottom))] max-w-[430px] border-t border-line bg-card px-2 pb-[env(safe-area-inset-bottom)] shadow-bar"
    >
      <NavLink to="/student" end className={tab}>
        <HomeIcon />
        Home
      </NavLink>
      <NavLink to="/student/rides" className={tab}>
        <span className="relative"><RidesIcon />{activeRide && <span className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-card" aria-hidden="true" />}</span>
        My Rides
        {activeRide && <span className="sr-only"> (active ride)</span>}
      </NavLink>
    </nav>
  );
}
