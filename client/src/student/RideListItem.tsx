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
      <Link to={`/student/rides/${encodeURIComponent(r.id)}`} className="flex items-center gap-3 rounded-tile bg-surface px-4 py-3 active:bg-brand-tint" data-testid="ride-item">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">
            {locationName(campus, r.pickupId)} <span className="text-muted" aria-label="to">→</span> {locationName(campus, r.destinationId)}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <PhasePill phase={ride.phase} />
            <span>{r.id}</span>
            <span>{formatSimTime(r.createdAt)}</span>
            <span>{r.freeLoyaltyRide ? "Free" : formatJod(r.fareJod)} (simulated)</span>
          </span>
        </span>
        <span className="text-muted"><ChevronIcon /></span>
      </Link>
    </li>
  );
}
