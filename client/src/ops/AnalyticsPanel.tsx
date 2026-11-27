/**
 * Operations dashboard: campus analytics (Phase 5 Prompt 2). Shows exactly what GET /api/analytics
 * returns, with each figure's unit, its time basis (history or now, simulated clock) and, for metrics the
 * saved data cannot support, the server's reason instead of a number. Nothing is computed here.
 * Refreshes whenever the live revision changes.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AnalyticsResponse, DurationStats, LocationActivity, Unavailable } from "../../../shared/analytics";
import { applyAnalyticsReply, createFetchAnalytics, type AnalyticsLoad, type FetchAnalytics } from "../lib/analyticsApi";
import { CART_STATUS_TEXT, REQUEST_STATUS_TEXT, TRIP_STATUS_TEXT } from "../lib/opsMetrics";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

/** Simulated seconds, rounded to whole seconds for display. */
export const simSeconds = (s: number) => `${Math.round(s)} s`;
const percent = (r: number | null) => (r === null ? "No data yet" : `${Math.round(r * 100)}%`);
const where = (l: { name: string | null; locationId: string; knownLocation: boolean }) => (l.knownLocation ? l.name ?? l.locationId : `${l.locationId} (not a location on this campus)`);

function Fig({ label, value, hint, testId }: { label: string; value: string | number; hint?: string; testId: string }) {
  return (
    <div className="rounded-tile bg-surface px-3 py-2">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="text-lg font-extrabold tabular-nums" data-testid={testId}>{value}</div>
      {hint && <div className="text-[13px] text-muted">{hint}</div>}
    </div>
  );
}

function NotAvailable({ label, metric, testId }: { label: string; metric: Unavailable; testId: string }) {
  return (
    <div className="rounded-tile border border-dashed border-line px-3 py-2" data-testid={testId} data-unavailable="true">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="text-sm font-bold text-muted">Not available</div>
      <div className="text-[13px] text-muted">{metric.reason}</div>
    </div>
  );
}

function Durations({ label, stats, population, testId }: { label: string; stats: DurationStats; population: string; testId: string }) {
  return (
    <div className="rounded-tile bg-surface px-3 py-2" data-testid={testId}>
      <div className="text-[13px] text-muted">{label}</div>
      {stats.measuredRequests === 0 ? (
        <div className="text-sm font-bold text-muted" data-testid={`${testId}-none`}>No measurements yet</div>
      ) : (
        <div className="text-sm">
          mean <b data-testid={`${testId}-mean`}>{simSeconds(stats.meanSeconds!)}</b> · median <b data-testid={`${testId}-median`}>{simSeconds(stats.medianSeconds!)}</b> · max <b data-testid={`${testId}-max`}>{simSeconds(stats.maxSeconds!)}</b>
        </div>
      )}
      <div className="text-[13px] text-muted">{population} · <span data-testid={`${testId}-n`}>{stats.measuredRequests}</span> measured · simulated seconds</div>
    </div>
  );
}

function LocationTable({ title, rows, testId }: { title: string; rows: LocationActivity[]; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <h4 className="mb-1 text-[13px] font-bold text-muted">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted" data-testid={`${testId}-empty`}>No ride requests yet.</p>
      ) : (
        <table className="w-full text-left text-[13px]" data-testid={testId}>
          <thead className="text-muted">
            <tr><th className="py-1 pr-2">Location</th><th className="pr-2">Requests</th><th className="pr-2">Active</th><th className="pr-2">Completed</th><th>Cancelled</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.locationId} className="border-t border-line" data-testid={`${testId}-${r.locationId}`}>
                <td className="py-1 pr-2">{where(r)}</td><td className="pr-2 font-bold">{r.totalRequests}</td><td className="pr-2">{r.activeRequests}</td><td className="pr-2">{r.completedRequests}</td><td>{r.cancelledRequests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Section({ title, basis, children }: { title: string; basis: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-extrabold">{title}</h3>
        <span className="text-[13px] text-muted">{basis}</span>
      </div>
      {children}
    </div>
  );
}

const HISTORY = "History: every record since this database was created";

/** The analytics content for one response. Pure: same response, same output. */
export function AnalyticsContent({ data }: { data: AnalyticsResponse }) {
  const { demand, locations, waiting, fleet, cancellations } = data;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted" data-testid="an-coverage">{data.coverage.note}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <NotAvailable label="Today / last 7 days / last 30 days" metric={data.coverage.calendarWindows} testId="an-calendar" />
        <NotAvailable label="Demand over time" metric={data.coverage.demandOverTime} testId="an-trend" />
      </div>

      <Section title="Demand" basis={HISTORY}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fig label="Ride requests" value={demand.totalRequests} hint="Every request, any status" testId="an-requests" />
          <Fig label="Active ride requests (now)" value={demand.activeRequests} hint="Requested, assigned, arriving or on board" testId="an-active" />
          <Fig label="Completed ride requests" value={demand.requestsByStatus.completed} testId="an-completed" />
          <Fig label="Cancelled ride requests" value={demand.requestsByStatus.cancelled} testId="an-cancelled" />
          <Fig label="Solo / shared requests" value={`${demand.requestsByMode.solo} / ${demand.requestsByMode.shared}`} hint="Ride requests by requested mode" testId="an-modes" />
          <Fig label="Cart trips" value={demand.totalTrips} hint="One trip can carry several requests" testId="an-trips" />
          <Fig label="Trips with 2+ riders" value={demand.tripsWithTwoOrMoreRiders} hint="Ghost Ride joins, cancelled riders included" testId="an-shared-trips" />
          <Fig label="Riders on trips / dropped off" value={`${demand.totalRiders} / ${demand.droppedOffRiders}`} hint="One rider entry per request placed on a trip" testId="an-riders" />
        </div>
        <p className="text-[13px] text-muted" data-testid="an-status-lines">
          Requests: {Object.entries(demand.requestsByStatus).map(([k, v]) => `${REQUEST_STATUS_TEXT[k as keyof typeof REQUEST_STATUS_TEXT]} ${v}`).join(" · ")}. Trips: {Object.entries(demand.tripsByStatus).map(([k, v]) => `${TRIP_STATUS_TEXT[k as keyof typeof TRIP_STATUS_TEXT]} ${v}`).join(" · ")}.
        </p>
      </Section>

      <Section title="Pickup and destination activity" basis={`${HISTORY} · counted in ride requests`}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <LocationTable title="Pickups" rows={locations.pickups} testId="an-pickups" />
          <LocationTable title="Destinations" rows={locations.destinations} testId="an-destinations" />
        </div>
      </Section>

      <Section title="Waiting" basis="Simulated clock · each measure has its own population">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Durations label="Request to Tap-In (arrival check-in, not boarding)" stats={waiting.requestToTapIn} population="History: requests with a Tap-In record" testId="an-tapin" />
          <Durations label="Current elapsed wait (still waiting, not finished)" stats={waiting.currentElapsedWait} population="Now: requests requested, assigned or arriving" testId="an-elapsed" />
          <Durations label="Request to drop-off" stats={waiting.requestToDropOff} population="History: completed requests" testId="an-dropoff" />
          <NotAvailable label="Request to boarding" metric={waiting.requestToBoarding} testId="an-boarding" />
        </div>
        {waiting.byPickup.length > 0 && (
          <div className="overflow-x-auto">
            <h4 className="mb-1 text-[13px] font-bold text-muted">By pickup location (simulated seconds)</h4>
            <table className="w-full text-left text-[13px]" data-testid="an-wait-by-pickup">
              <thead className="text-muted"><tr><th className="py-1 pr-2">Pickup</th><th className="pr-2">Request to Tap-In: mean (measured)</th><th>Current elapsed wait: max (waiting now)</th></tr></thead>
              <tbody>
                {waiting.byPickup.map((p) => (
                  <tr key={p.locationId} className="border-t border-line" data-testid={`an-wait-${p.locationId}`}>
                    <td className="py-1 pr-2">{where(p)}</td>
                    <td className="pr-2">{p.requestToTapIn.meanSeconds === null ? "No measurements" : `${simSeconds(p.requestToTapIn.meanSeconds)} (${p.requestToTapIn.measuredRequests})`}</td>
                    <td>{p.currentElapsedWait.maxSeconds === null ? "Nobody waiting" : `${simSeconds(p.currentElapsedWait.maxSeconds)} (${p.currentElapsedWait.measuredRequests})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Fleet" basis="Now, except per-cart trips (history)">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fig label="Carts in fleet" value={fleet.totalCarts} testId="an-carts" />
          <Fig label="Out of service carts" value={fleet.outOfServiceCarts} hint="Charging, offline or maintenance" testId="an-out-of-service" />
          <Fig label="Seats occupied now" value={`${fleet.seatOccupancy.onBoardPassengers}/${fleet.seatOccupancy.totalSeats} (${percent(fleet.seatOccupancy.ratio)})`} hint="Passengers on board ÷ seats of all carts" testId="an-occupancy" />
          <NotAvailable label="Carts eligible for dispatch" metric={fleet.dispatchEligibleCarts} testId="an-eligible" />
        </div>
        <p className="text-[13px] text-muted" data-testid="an-cart-statuses">
          Carts by status: {Object.entries(fleet.cartsByStatus).map(([k, v]) => `${CART_STATUS_TEXT[k as keyof typeof CART_STATUS_TEXT]} ${v}`).join(" · ")}.
        </p>
        <NotAvailable label="Utilization over time" metric={fleet.utilizationOverTime} testId="an-utilization" />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]" data-testid="an-per-cart">
            <thead className="text-muted"><tr><th className="py-1 pr-2">Cart</th><th className="pr-2">Trips</th><th className="pr-2">Completed</th><th className="pr-2">Cancelled</th><th className="pr-2">Open</th><th>Riders dropped off</th></tr></thead>
            <tbody>
              {fleet.perCart.map((c) => (
                <tr key={c.cartId} className="border-t border-line" data-testid={`an-cart-${c.cartId}`}>
                  <td className="py-1 pr-2">{c.label} ({c.cartId})</td><td className="pr-2 font-bold">{c.totalTrips}</td><td className="pr-2">{c.completedTrips}</td><td className="pr-2">{c.cancelledTrips}</td><td className="pr-2">{c.openTrips}</td><td>{c.droppedOffRiders}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Cancellations" basis={HISTORY}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Fig label="Cancelled share of finished requests" value={`${cancellations.cancelledRequests} of ${cancellations.finishedRequests} (${percent(cancellations.shareOfFinished)})`} hint="Finished = completed or cancelled" testId="an-cancel-share" />
          <NotAvailable label="Step at which rides were cancelled" metric={cancellations.cancelledAtStage} testId="an-cancel-stage" />
        </div>
      </Section>

      <Section title="Observations" basis="Facts about the measured values above; not diagnoses">
        {data.observations.length === 0 ? (
          <p className="text-[13px] text-muted" data-testid="an-observations-empty">Nothing to observe yet: no ride requests have been made.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-[13px]" data-testid="an-observations">
            {data.observations.map((o) => (
              <li key={o.metric} className="rounded-tile bg-surface px-3 py-1.5">
                {o.text} <span className="text-muted">({o.population}; {o.window})</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** The analytics card for one load state: loading, error (with any older result) or ready. */
export function AnalyticsView({ load }: { load: AnalyticsLoad }) {
  return (
    <Card id="ops-analytics" className="scroll-mt-24 flex flex-col gap-3 p-4" role="region" aria-labelledby="analytics-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="analytics-title" className="text-[17px] font-extrabold">Campus analytics</h2>
        <div className="flex flex-wrap gap-1.5">
          <Badge emphasis="strong">Descriptive only</Badge>
          <Badge emphasis="strong">Simulated clock</Badge>
        </div>
      </div>
      {load.status === "loading" && <p role="status" className="text-sm text-muted" data-testid="an-loading">Loading analytics…</p>}
      {load.status === "error" && (
        <p role="alert" className="rounded-tile bg-danger-tint px-3 py-2 text-[13px] text-ink" data-testid="an-error">
          Could not load analytics: {load.message}{load.data ? ` Showing the last result (revision ${load.data.revision}), which may be out of date.` : ""}
        </p>
      )}
      {(load.status === "ready" || (load.status === "error" && load.data)) && (
        <>
          <p className="text-[13px] text-muted" data-testid="an-revision">Computed from revision {(load.status === "ready" ? load.data : load.data!).revision} of the saved ride state.</p>
          <AnalyticsContent data={load.status === "ready" ? load.data : load.data!} />
        </>
      )}
    </Card>
  );
}

/** Loads analytics for the current live revision and refreshes when it changes. */
export function AnalyticsPanel({ revision, fetchAnalytics }: { revision: number; fetchAnalytics?: FetchAnalytics }) {
  const load = useMemo(() => fetchAnalytics ?? createFetchAnalytics(), [fetchAnalytics]);
  const [state, setState] = useState<AnalyticsLoad>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => alive && setState((s) => applyAnalyticsReply(s, { ok: true, data })))
      .catch((e: Error) => alive && setState((s) => applyAnalyticsReply(s, { ok: false, message: e.message })));
    return () => { alive = false; };
  }, [load, revision]);
  return <AnalyticsView load={state} />;
}
