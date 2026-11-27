import { SETTINGS } from "../../../shared/settings";
import { Card } from "../ui/Card";
import { formatJod } from "./format";
import { loyaltyLine, loyaltyOf } from "./loyalty";
import { StudentPage } from "./StudentPage";
import { StillConnectingNote, useStudent } from "./studentContext";

/**
 * Campus Impact and rewards: this student's own ride record from the live state, and the approved loyalty
 * rule with the student's real progress (the server grants the free ride). There is no Impact Score: it
 * would need measured data (for example energy or emissions) the app does not have.
 */
/** Progress towards the next free ride: one step per completed paid ride since the last free ride. */
function LoyaltyMeter({ rides }: { rides: ReturnType<typeof useStudent>["rides"] }) {
  const l = loyaltyOf(rides);
  const shown = Math.min(l.paidSinceFree, l.needed);
  return (
    <div className="flex flex-col gap-2" data-testid="impact-loyalty">
      <ol className="grid grid-cols-6 gap-1.5" aria-label="Loyalty progress">
        {Array.from({ length: l.needed + 1 }, (_, i) => {
          const isFree = i === l.needed;
          const done = isFree ? l.freeRideDue : i < shown;
          return (
            <li key={i} className={`flex h-10 items-center justify-center rounded-tile text-[13px] font-bold ${done ? (isFree ? "bg-success-tint text-ink ring-2 ring-success" : "bg-brand text-white") : "bg-surface text-muted ring-1 ring-line"}`}>
              {isFree ? "Free" : i + 1}
              <span className="sr-only">{done ? " (done)" : " (not yet)"}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-[13px] font-semibold text-ink" data-testid="impact-loyalty-note">{loyaltyLine(rides)}</p>
    </div>
  );
}

export function ImpactView({ back = true }: { back?: boolean }) {
  const { rides, realtime } = useStudent();
  const completed = rides.filter((r) => r.request.status === "completed");
  const paid = completed.filter((r) => !r.request.freeLoyaltyRide);
  const cancelled = rides.filter((r) => r.request.status === "cancelled");
  return (
    <StudentPage id="impact-title" title="Campus Impact" back={back ? { to: "/student/quick", label: "Quick actions" } : undefined}>
      {realtime.data === null ? (
        <div className="flex flex-col gap-2">
          <p className="rounded-card bg-surface px-4 py-6 text-center text-sm text-muted" role="status">Loading your rides…</p>
          <StillConnectingNote />
        </div>
      ) : (
        <>
          <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby="impact-record">
            <h2 id="impact-record" className="text-[17px] font-bold">Your ride record</h2>
            <dl className="grid grid-cols-3 gap-2 text-center">
              {([["Completed", completed.length, "impact-completed"], ["Paid", paid.length, "impact-paid"], ["Cancelled", cancelled.length, "impact-cancelled"]] as const).map(([k, v, id]) => (
                <div key={k} className="rounded-tile bg-surface px-2 py-2.5">
                  <dt className="text-[13px] text-muted">{k}</dt>
                  <dd className="text-[26px] font-extrabold leading-tight tabular-nums" data-testid={id}>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[13px] text-muted">Counted from your rides on the demo server. Fares are simulated: {formatJod(SETTINGS.fareJod)} per ride, no payment taken.</p>
          </Card>
          <Card className="flex flex-col gap-2 p-4" role="region" aria-labelledby="impact-rewards">
            <h2 id="impact-rewards" className="text-[17px] font-bold">Campus ride rewards</h2>
            <p className="text-[15px] text-ink">After {SETTINGS.loyaltyPaidRidesForFree} completed paid rides, the next one is free. Cancelled and free rides do not count.</p>
            <LoyaltyMeter rides={rides} />
          </Card>
          <Card className="flex flex-col gap-2 p-4" role="region" aria-labelledby="impact-score">
            <h2 id="impact-score" className="text-[17px] font-bold">Campus Impact Score</h2>
            <p className="text-[15px] font-semibold text-ink-2" data-testid="impact-score-unavailable">Not available</p>
            <p className="text-[13px] text-muted">No verified impact measurement (such as CO₂ saved) exists for these simulated rides, so no score or estimate is shown.</p>
          </Card>
        </>
      )}
    </StudentPage>
  );
}
