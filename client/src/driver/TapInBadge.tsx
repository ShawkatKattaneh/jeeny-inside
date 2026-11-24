import type { arrivalState } from "../lib/tapIn";
import { formatSimTime } from "../student/format";

/**
 * Phase 4 Tap-In, read-only: shown only while the rider tapped in at the CURRENT pickup and is still
 * waiting. It is not boarding: the driver's own button still boards the rider.
 */
export function TapInBadge({ arrival }: { arrival: ReturnType<typeof arrivalState> }) {
  if (arrival?.kind !== "current") return null;
  return (
    <span className="ml-2 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-warning" data-testid="driver-tapin" title={`Tap-In recorded at ${formatSimTime(arrival.atMs)} (not verified)`}>
      Tapped in · not boarded
    </span>
  );
}
