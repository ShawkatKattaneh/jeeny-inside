import { Link } from "react-router-dom";
import { RideListItem } from "./RideListItem";
import { useStudent } from "./studentContext";

/** The student's own rides from the live state: active first, then completed and cancelled. */
export function RidesView() {
  const { realtime, rides } = useStudent();
  const active = rides.filter((r) => r.active);
  const past = rides.filter((r) => !r.active);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="rides-title">
      <div>
        <h1 id="rides-title" className="text-2xl font-extrabold tracking-tight">Your rides</h1>
        <p className="text-xs text-muted">
          Rides are kept in the server's memory for this demo session and are cleared when the server restarts.
        </p>
      </div>

      {realtime.data === null ? (
        <p className="rounded-tile bg-surface px-4 py-6 text-center text-sm text-muted" role="status">Loading your rides…</p>
      ) : rides.length === 0 ? (
        <div className="rounded-tile bg-surface px-4 py-6 text-center text-sm">
          <p className="font-semibold">No rides yet</p>
          <p className="mt-1 text-muted">
            Book your first ride from <Link to="/student" className="font-semibold text-brand">Home</Link>.
          </p>
        </div>
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-sm font-bold">Active</h2>
            {active.length === 0 ? <p className="text-xs text-muted">No active ride.</p> : (
              <ul className="flex flex-col gap-2">{active.map((r) => <RideListItem key={r.request.id} ride={r} />)}</ul>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-bold">Past rides</h2>
            {past.length === 0 ? <p className="text-xs text-muted">No completed or cancelled rides yet.</p> : (
              <ul className="flex flex-col gap-2">{past.map((r) => <RideListItem key={r.request.id} ride={r} />)}</ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
