import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PHASE_LABEL } from "../lib/studentRides";
import { passengerOf } from "../lib/tapIn";
import { formatJod, formatSimTime, locationName } from "./format";
import { RideStatusCard } from "./RideStatusCard";
import { StudentMap } from "./StudentMap";
import { useStudent } from "./studentContext";

/**
 * One of the student's rides. Only rides whose studentId is this student's are found here; any other
 * id shows "not found" rather than another student's ride.
 */
export function RideDetailView() {
  const { requestId = "" } = useParams();
  const { campus, realtime, rides } = useStudent();
  const ride = rides.find((r) => r.request.id === requestId) ?? null;

  if (!ride) {
    return (
      <section className="flex flex-col gap-3">
        <Link to="/student/rides" className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-brand">← Your rides</Link>
        <p className="rounded-tile bg-surface px-4 py-6 text-center text-sm text-muted" role="status">
          {realtime.data === null ? "Loading ride…" : "This ride was not found among your rides."}
        </p>
      </section>
    );
  }

  const r = ride.request;
  const tapped = passengerOf(ride.trip, r.id)?.tappedIn;
  const secondary = (s: string) => <span className="block text-[13px] font-normal text-muted">{s}</span>;
  const rows: [string, ReactNode][] = [
    ["Request", r.id],
    ["Status", <>{PHASE_LABEL[ride.phase]}{secondary(`server status: ${r.status}`)}</>],
    // Phase 4: shared rides only (solo rows are unchanged). Your ride's status above; the trip's below.
    ...(r.mode === "shared" ? [["Ride type", "Shared (your own ride and fare; the cart's trip may carry other riders)"] as [string, ReactNode]] : []),
    ["Pickup", locationName(campus, r.pickupId)],
    ["Destination", locationName(campus, r.destinationId)],
    ["Cart", ride.cart?.label ?? ride.cartLabel ?? (ride.active ? "Not assigned yet" : "None")],
    ["Trip", ride.trip ? <>{ride.trip.id}{secondary(`trip status: ${ride.trip.status}`)}</> : "No trip"],
    ["Fare", `${r.freeLoyaltyRide ? "Free loyalty ride" : formatJod(r.fareJod)} (simulated, no payment taken)`],
    ["Requested", formatSimTime(r.createdAt)],
    ["Last update", formatSimTime(r.updatedAt)],
    // Phase 4 Tap-In: the recorded check-in (history; never boarding, never verified presence).
    ...(tapped ? [["Tap-In", `${locationName(campus, tapped.locationId)} at ${formatSimTime(tapped.atMs)} (check-in only, not verified)`] as [string, ReactNode]] : []),
  ];

  return (
    <section className="grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-start">
      <div className="flex flex-col gap-3 md:order-2">
        <Link to="/student/rides" className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-brand">← Your rides</Link>
        <RideStatusCard ride={ride} showDetailsLink={false} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-tile bg-surface px-4 py-3 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-words font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[13px] text-muted">Times are simulation time since the server started, not clock time.</p>
      </div>
      <div className="md:order-1">
        <StudentMap ride={ride.active ? ride : null} pickupId={r.pickupId} destinationId={r.destinationId} />
      </div>
    </section>
  );
}
