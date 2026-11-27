import { Link } from "react-router-dom";
import { LiveStatus } from "./LiveStatus";
import { RideListItem } from "./RideListItem";
import { StillConnectingNote, useStudent } from "./studentContext";

/** The student's own rides from the live state: active first, then completed and cancelled. */
export function RidesView() {
  const { realtime, rides } = useStudent();
  const active = rides.filter((r) => r.active);
  const past = rides.filter((r) => !r.active);

  return (
    <section className="flex flex-col gap-5 px-4 pb-6 pt-5" aria-labelledby="rides-title">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h1 id="rides-title" className="text-[26px] font-extrabold leading-tight tracking-tight">Your rides</h1>
          <LiveStatus status={realtime.status} />
        </div>
        <p className="mt-1 text-[13px] text-muted">
          Rides are saved in the demo server's database for this campus, so they are still here after the server restarts.
        </p>
      </div>

      {realtime.data === null ? (
        <div className="flex flex-col gap-2">
          <p className="rounded-card bg-surface px-4 py-6 text-center text-sm text-muted" role="status">Loading your rides…</p>
          <StillConnectingNote />
        </div>
      ) : rides.length === 0 ? (
        <div className="rounded-card bg-surface px-4 py-8 text-center text-sm">
          <p className="font-semibold">No rides yet</p>
          <p className="mt-1 text-muted">
            Book your first ride from <Link to="/student" className="font-semibold text-ink underline underline-offset-2">Home</Link>.
          </p>
        </div>
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-[17px] font-bold">Active</h2>
            {active.length === 0 ? <p className="text-[13px] text-muted">No active ride.</p> : (
              <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card ring-1 ring-line">{active.map((r) => <RideListItem key={r.request.id} ride={r} />)}</ul>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-[17px] font-bold">Past rides</h2>
            {past.length === 0 ? <p className="text-[13px] text-muted">No completed or cancelled rides yet.</p> : (
              <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card ring-1 ring-line">{past.map((r) => <RideListItem key={r.request.id} ride={r} />)}</ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
