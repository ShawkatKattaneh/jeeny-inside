import { useState } from "react";
import { Link } from "react-router-dom";
import { BookingPanel, type Selection } from "./BookingPanel";
import { PricingExplainer } from "./FareInfo";
import { RideListItem } from "./RideListItem";
import { RideStatusCard } from "./RideStatusCard";
import { StudentMap } from "./StudentMap";
import { useStudent } from "./studentContext";

/** Student home: the active ride (or the booking form), the campus map, fares and recent rides. */
export function HomeView() {
  const { persona, campus, realtime, rides, activeRide } = useStudent();
  const [selection, setSelection] = useState<Selection>({ pickupId: "", destinationId: "" });
  const recent = rides.filter((r) => !r.active).slice(0, 3);
  const loading = realtime.data === null;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-start">
      <section className="flex flex-col gap-3 md:order-2" aria-label="Book or follow a ride">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Hi {persona.name}</h1>
          <p className="text-sm text-muted">{campus.name}</p>
        </div>
        {loading ? (
          <p className="rounded-tile bg-surface px-4 py-6 text-center text-sm text-muted" role="status">
            Loading your rides…
          </p>
        ) : activeRide ? (
          <RideStatusCard ride={activeRide} />
        ) : (
          <BookingPanel selection={selection} onChange={setSelection} />
        )}
        <PricingExplainer />
      </section>

      <section className="flex flex-col gap-4 md:order-1" aria-label="Campus map and recent rides">
        <StudentMap ride={activeRide} pickupId={selection.pickupId} destinationId={selection.destinationId} />
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-bold">Recent rides</h2>
            <Link to="/student/rides" className="text-xs font-semibold text-brand">
              All rides
            </Link>
          </div>
          {loading ? null : recent.length === 0 ? (
            <p className="text-xs text-muted">No finished rides yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recent.map((r) => <RideListItem key={r.request.id} ride={r} />)}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
