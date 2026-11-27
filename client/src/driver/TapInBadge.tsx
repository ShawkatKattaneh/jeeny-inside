import type { arrivalState } from "../lib/tapIn";
import { formatSimTime } from "../student/format";

/**
 * Phase 4 Tap-In, read-only: shown only while the rider tapped in at the CURRENT pickup and is still
 * waiting. It is not boarding: the driver's own button still boards the rider.
 */
export function TapInBadge({ arrival }: { arrival: ReturnType<typeof arrivalState> }) {
  if (arrival?.kind !== "current") return null;
  return (
    <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-info-tint px-2.5 py-0.5 text-[13px] font-bold text-ink ring-1 ring-info/30 before:inline-block before:h-0 before:w-0 before:shrink-0 before:border-x-[5px] before:border-b-[9px] before:border-x-transparent before:border-b-info before:content-['']" data-testid="driver-tapin" title={`Tap-In recorded at ${formatSimTime(arrival.atMs)} (not verified)`}>
      Tapped in · not boarded
    </span>
  );
}
