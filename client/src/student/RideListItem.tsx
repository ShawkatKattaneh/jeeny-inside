import { Link } from "react-router-dom";
import type { StudentRide } from "../lib/studentRides";
import { ChevronIcon } from "../ui/icons";
import { formatJod, formatSimTime, locationName } from "./format";
import { PhasePill } from "./RideStatusCard";
import { useStudent } from "./studentContext";

export function RideListItem({ ride }: { ride: StudentRide }) {
  const { campus } = useStudent();
  const r = ride.request;
  return (
    <li>
      <Link to={`/student/rides/${encodeURIComponent(r.id)}`} className="flex min-h-14 items-center gap-3 bg-card px-4 py-3 transition-colors duration-150 hover:bg-surface active:bg-brand-tint" data-testid="ride-item">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold">
            {locationName(campus, r.pickupId)} <span className="text-muted" aria-label="to">→</span> {locationName(campus, r.destinationId)}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <PhasePill phase={ride.phase} />
            <span>{r.id}</span>
            {r.mode === "shared" && <span className="font-bold text-brand-strong">Shared</span>}
            <span>{formatSimTime(r.createdAt)}</span>
            <span className="text-[13px]">{r.freeLoyaltyRide ? "Free" : formatJod(r.fareJod)} (simulated)</span>
          </span>
        </span>
        <span className="text-muted"><ChevronIcon /></span>
      </Link>
    </li>
  );
}
