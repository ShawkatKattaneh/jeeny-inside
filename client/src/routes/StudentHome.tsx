import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
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
import { CampusMapView } from "../student/CampusMapView";
import { CopilotView } from "../student/CopilotView";
import { ImpactView } from "../student/ImpactView";
import { PriorityView } from "../student/PriorityView";
import { ProfileView } from "../student/ProfileView";
import { PulseView } from "../student/PulseView";
import { QuickView } from "../student/QuickView";
import { HomeIcon, MapIcon, ProfileIcon, QuickIcon, RidesIcon } from "../ui/icons";
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
            <Route path="quick" element={<QuickView />} />
            <Route path="map" element={<CampusMapView />} />
            <Route path="profile" element={<ProfileView />} />
            <Route path="impact" element={<ImpactView />} />
            <Route path="pulse" element={<PulseView />} />
            <Route path="priority" element={<PriorityView />} />
            <Route path="copilot" element={<CopilotView />} />
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
 * Student navigation: the approved five tabs (Home, Quick, My Rides, Campus Map, Profile), always a bottom
 * tab bar inside the phone column. Quick holds Tap-In, Campus Pulse, Impact, Priority / SOS and Copilot.
 */
function StudentNav() {
  const { activeRide } = useStudent();
  const { pathname } = useLocation();
  const inQuick = ["/student/quick", "/student/pulse", "/student/impact", "/student/priority", "/student/copilot"].some((p) => pathname.startsWith(p));
  const tab = (forceActive = false) => ({ isActive }: { isActive: boolean }) =>
    `relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[12px] leading-tight transition-colors duration-150 ${isActive || forceActive ? "font-bold text-brand-strong before:absolute before:inset-x-4 before:top-0 before:h-[3px] before:rounded-b-full before:bg-brand before:content-['']" : "font-semibold text-muted hover:text-ink"}`;
  return (
    <nav
      aria-label="Student"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto flex h-[calc(3.5rem+env(safe-area-inset-bottom))] max-w-[430px] border-t border-line bg-card px-1 pb-[env(safe-area-inset-bottom)] shadow-bar"
    >
      <NavLink to="/student" end className={tab()}>
        <HomeIcon />
        Home
      </NavLink>
      <NavLink to="/student/quick" className={tab(inQuick)} aria-current={inQuick ? "page" : undefined}>
        <QuickIcon />
        Quick
      </NavLink>
      <NavLink to="/student/rides" className={tab()}>
        <span className="relative"><RidesIcon />{activeRide && <span className="absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-card" aria-hidden="true" />}</span>
        <span className="whitespace-nowrap">My Rides</span>
        {activeRide && <span className="sr-only"> (active ride)</span>}
      </NavLink>
      <NavLink to="/student/map" className={tab()}>
        <MapIcon />
        Map
      </NavLink>
      <NavLink to="/student/profile" className={tab()}>
        <ProfileIcon />
        Profile
      </NavLink>
    </nav>
  );
}
