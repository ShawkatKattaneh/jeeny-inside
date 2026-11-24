import { Link, useParams } from "react-router-dom";
import { PHASE_LABEL } from "../lib/studentRides";
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
        <Link to="/student/rides" className="text-sm font-semibold text-brand">← Your rides</Link>
        <p className="rounded-tile bg-surface px-4 py-6 text-center text-sm text-muted" role="status">
          {realtime.data === null ? "Loading ride…" : "This ride was not found among your rides."}
        </p>
      </section>
    );
  }

  const r = ride.request;
  const rows: [string, string][] = [
    ["Request", r.id],
    ["Status", `${PHASE_LABEL[ride.phase]} (server status: ${r.status})`],
    ["Pickup", locationName(campus, r.pickupId)],
    ["Destination", locationName(campus, r.destinationId)],
    ["Cart", ride.cart?.label ?? ride.cartLabel ?? (ride.active ? "Not assigned yet" : "None")],
    ["Trip", ride.trip ? `${ride.trip.id} (${ride.trip.status})` : "No trip"],
    ["Fare", `${r.freeLoyaltyRide ? "Free loyalty ride" : formatJod(r.fareJod)} (simulated, no payment taken)`],
    ["Requested", formatSimTime(r.createdAt)],
    ["Last update", formatSimTime(r.updatedAt)],
  ];

  return (
    <section className="grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-start">
      <div className="flex flex-col gap-3 md:order-2">
        <Link to="/student/rides" className="text-sm font-semibold text-brand">← Your rides</Link>
        <RideStatusCard ride={ride} showDetailsLink={false} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-tile bg-surface px-4 py-3 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-words font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[11px] text-muted">Times are simulation time since the server started, not clock time.</p>
      </div>
      <div className="md:order-1">
        <StudentMap ride={ride.active ? ride : null} pickupId={r.pickupId} destinationId={r.destinationId} />
      </div>
    </section>
  );
}
