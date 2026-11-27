import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StudentRide } from "../lib/studentRides";
import { Card } from "../ui/Card";
import { formatJod, locationName } from "./format";
import { loyaltyLine } from "./loyalty";
import { useStudent } from "./studentContext";

const WATCHED = "jeeny-inside:watched-rides";
const DISMISSED = "jeeny-inside:dismissed-results";
const read = (k: string): string[] => { try { return JSON.parse(sessionStorage.getItem(k) ?? "[]"); } catch { return []; } };
const write = (k: string, v: string[]) => { try { sessionStorage.setItem(k, JSON.stringify(v.slice(-50))); } catch { /* storage blocked */ } };

/**
 * The ride that finished while this student was following it (in this browser session), until they
 * dismiss it. Old history never pops up: only rides seen active in this session qualify.
 */
export function useJustFinished(rides: StudentRide[]): { ride: StudentRide | null; dismiss: () => void } {
  const [, force] = useState(0);
  const activeIds = rides.filter((r) => r.active && r.synced).map((r) => r.request.id);
  useEffect(() => {
    if (activeIds.length === 0) return;
    const w = read(WATCHED);
    const add = activeIds.filter((id) => !w.includes(id));
    if (add.length) write(WATCHED, [...w, ...add]);
  }, [activeIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const watched = read(WATCHED);
  const dismissed = read(DISMISSED);
  const ride = rides
    .filter((r) => !r.active && watched.includes(r.request.id) && !dismissed.includes(r.request.id))
    .sort((a, b) => b.request.updatedAt - a.request.updatedAt)[0] ?? null;
  return {
    ride,
    dismiss: () => { if (ride) { write(DISMISSED, [...read(DISMISSED), ride.request.id]); force((n) => n + 1); } },
  };
}

/** Result of a ride the student just followed to the end: completed (with fare) or cancelled (no charge). */
export function RideResultCard({ ride, onDismiss }: { ride: StudentRide; onDismiss: () => void }) {
  const { campus, rides } = useStudent();
  const r = ride.request;
  const done = r.status === "completed";
  const loyalty = loyaltyLine(rides);
  return (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby={`result-${r.id}`} data-testid="ride-result" data-result={r.status}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] text-muted">Ride · {r.id}{ride.cartLabel ? ` · ${ride.cartLabel}` : ""}</div>
          <h2 id={`result-${r.id}`} tabIndex={-1} className="scroll-mt-12 text-2xl font-extrabold tracking-tight">{done ? "Ride completed" : "Ride cancelled"}</h2>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-bold ${done ? "bg-success-tint text-ink before:h-2 before:w-2 before:rounded-[2px] before:bg-success before:content-['']" : "bg-surface text-ink-2"}`}>{done ? "Completed" : "Cancelled"}</span>
      </div>
      <p className="text-[15px] text-ink">
        {locationName(campus, r.pickupId)} <span className="text-muted" aria-label="to">→</span> {locationName(campus, r.destinationId)}
      </p>
      <div className="flex items-center justify-between rounded-tile bg-surface px-3 py-2.5">
        <span className="text-[14px] text-muted">{done ? "Fare (simulated, no payment)" : "Fare"}</span>
        <span className="text-[17px] font-extrabold" data-testid="result-fare">{done ? (r.freeLoyaltyRide ? "Free" : formatJod(r.fareJod)) : "No charge"}</span>
      </div>
      {done ? (
        <p className="text-[13px] text-muted" data-testid="result-loyalty">
          {r.freeLoyaltyRide ? "This was your free loyalty ride. " : ""}{loyalty}
        </p>
      ) : (
        <p className="text-[13px] text-muted">Cancelled before boarding. No fare is charged.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onDismiss} className="min-h-11 flex-1 rounded-full bg-brand px-4 text-[15px] font-bold text-white hover:bg-brand-press" data-testid="result-book-again">Book another ride</button>
        <Link to={`/student/rides/${encodeURIComponent(r.id)}`} className="inline-flex min-h-11 items-center rounded-full bg-card px-4 text-sm font-semibold text-ink ring-1 ring-line hover:bg-surface">Ride details</Link>
      </div>
    </Card>
  );
}
