import type { CampusConfig, Persona, StateSnapshot } from "../../../shared/schemas";
import { SETTINGS } from "../../../shared/settings";
import { isSharedTrip } from "../lib/driverWork";
import { CART_STATUS_TEXT, RIDER_STATE_TEXT, TRIP_STATUS_TEXT, tripRiderCounts } from "../lib/opsMetrics";
import { opsTapInText } from "../lib/tapIn";
import { Card } from "../ui/Card";
import { locationName } from "../student/format";
import { studentText } from "./opsFormat";
import type { Selected } from "./OpsPanels";

const OPEN = ["planned", "active", "cancelling"];
const mins = (s: number) => `${(s / 60).toFixed(1)} min`;

/**
 * Ghost Ride monitoring: every shared trip (a trip that carried or carries more than one request), its
 * stops in the server's order and each rider's own lifecycle. Planned solo times are the engine's recorded
 * baseline; actual pickup and drop-off times are not recorded, so no delay figure is shown.
 */
export function GhostRidePanel({ data, campus, personas, onSelect }: { data: StateSnapshot; campus: CampusConfig; personas: Persona[]; onSelect: (s: Selected) => void }) {
  const shared = data.trips.filter((t) => isSharedTrip(data, t)).sort((a, b) => Number(OPEN.includes(b.status)) - Number(OPEN.includes(a.status)) || (a.id < b.id ? 1 : -1));
  return (
    <Card id="ops-ghost" className="scroll-mt-24 flex flex-col gap-3 p-4" role="region" aria-labelledby="ghost-title" data-testid="ghost-ride-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ghost-title" className="text-[17px] font-extrabold">Ghost Ride (shared trips)</h2>
        <span className="text-[13px] text-muted">Tap-In is a check-in, never boarding · max added delay {SETTINGS.sharedMaxAddedDelayMinutes} min</span>
      </div>
      {shared.length === 0 ? (
        <p className="rounded-tile bg-surface px-3 py-4 text-center text-sm text-muted" data-testid="ghost-empty">No shared trips yet. A trip becomes shared when dispatch joins a Shared request to it.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shared.map((t) => {
            const c = tripRiderCounts(t);
            const cart = data.carts.find((x) => x.id === t.cartId);
            return (
              <li key={t.id} className="rounded-tile ring-1 ring-line" data-testid="ghost-trip">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2.5">
                  <button type="button" className="relative text-[15px] font-bold underline-offset-2 after:absolute after:-inset-2 after:content-[''] hover:underline" onClick={() => onSelect({ kind: "trip", id: t.id })}>{t.id}</button>
                  <span className="text-[13px] text-ink-2">{cart?.label ?? t.cartId} · Trip: <b className="text-ink">{TRIP_STATUS_TEXT[t.status]}</b> · {c.committed} committed{cart ? ` of ${cart.seats} seats` : ""} · {c.onBoard} on board</span>
                </div>
                <p className="px-3 pt-2 text-[13px] text-muted">
                  Stops: {t.stops.map((s, i) => `${i + 1}. ${locationName(campus, s.locationId)}${i < t.stopIndex ? " (done)" : ""}`).join(" → ")}
                </p>
                <ul className="divide-y divide-line px-3">
                  {t.passengers.map((p) => {
                    const r = data.requests.find((x) => x.id === p.requestId);
                    const state = RIDER_STATE_TEXT[p.cancelled ? "cancelled" : p.droppedOff ? "dropped_off" : p.boarded ? "on_board" : "waiting"];
                    const tap = r ? opsTapInText(r, p, (id) => locationName(campus, id)) : null;
                    return (
                      <li key={p.requestId} className="flex flex-col gap-0.5 py-2 text-[13px]">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span><b className="text-sm">{p.requestId}</b> <span className="text-muted">{r ? studentText(r.studentId, personas) : "Not in the live state"}</span></span>
                          <span className="font-semibold">{state}</span>
                        </div>
                        <span className="text-ink-2">{r ? `${locationName(campus, r.pickupId)} → ${locationName(campus, r.destinationId)}` : "Unknown route"}</span>
                        <span className="text-muted">
                          {p.baseline ? `Planned solo: pickup ${mins(p.baseline.soloPickupSeconds)}, ride ${mins(p.baseline.soloRideSeconds)} (engine baseline). Actual delay: not recorded.` : "No solo baseline recorded."}
                          {tap ? ` ${tap}.` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * Battery monitoring: each cart's battery and range as the server reports them, against the approved
 * reserve. Monitoring only: there is no automatic rescue, charging advice or battery forecast.
 */
export function BatteryPanel({ data, onSelect }: { data: StateSnapshot; onSelect: (s: Selected) => void }) {
  const carts = [...data.carts].sort((a, b) => a.batteryPercent - b.batteryPercent);
  const low = carts.filter((c) => c.batteryPercent < SETTINGS.batteryReservePercent).length;
  return (
    <Card id="ops-battery" className="scroll-mt-24 flex flex-col gap-3 p-4" role="region" aria-labelledby="battery-title" data-testid="battery-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="battery-title" className="text-[17px] font-extrabold">Battery Rescue</h2>
        <span className="text-[13px] text-muted">{low === 0 ? `No cart below the ${SETTINGS.batteryReservePercent}% reserve` : `${low} cart${low === 1 ? "" : "s"} below the ${SETTINGS.batteryReservePercent}% reserve`}</span>
      </div>
      <p className="rounded-tile bg-surface px-3 py-2 text-[13px] text-ink-2">Battery values are the simulated fleet's. Recommendations follow one rule, the approved {SETTINGS.batteryReservePercent}% reserve, and are advice only: nothing is sent to a cart automatically, and there is no battery prediction.</p>
      <ul className="flex flex-col gap-1.5" data-testid="battery-recommendations">
        {(() => {
          const lowCarts = carts.filter((c) => c.batteryPercent < SETTINGS.batteryReservePercent);
          if (lowCarts.length === 0) return <li className="rounded-tile bg-success-tint px-3 py-2 text-[13px] text-ink">No rescue needed: every cart is at or above the {SETTINGS.batteryReservePercent}% reserve.</li>;
          return lowCarts.map((c) => (
            <li key={c.id} className="rounded-tile bg-warning-tint px-3 py-2 text-[13px] text-ink" data-testid="battery-recommendation">
              <b>Recommend charging {c.label}</b>: {Math.round(c.batteryPercent)}% is below the reserve, so dispatch gives it no new trips.{c.status === "occupied" || c.status === "assigned" ? " Let it finish its current trip first." : " It is free to go to the depot now."}
            </li>
          ));
        })()}
      </ul>
      <ul className="flex flex-col gap-2">
        {carts.map((c) => {
          const pct = Math.max(0, Math.min(100, c.batteryPercent));
          const isLow = c.batteryPercent < SETTINGS.batteryReservePercent;
          return (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-tile px-3 py-2 ring-1 ring-line" data-testid="battery-row">
              <button type="button" className="relative w-20 text-left text-[15px] font-bold underline-offset-2 after:absolute after:-inset-2 after:content-[''] hover:underline" onClick={() => onSelect({ kind: "cart", id: c.id })}>{c.label}</button>
              <span className="min-w-[8rem] flex-1">
                <span className="flex items-baseline justify-between text-[13px]"><span className="font-bold tabular-nums">{Math.round(c.batteryPercent)}%</span><span className="text-muted">{c.rangeKm} km range</span></span>
                <span className="mt-1 block h-2 overflow-hidden rounded-full bg-line" aria-hidden="true"><span className={`block h-full ${isLow ? "bg-warning" : "bg-success"}`} style={{ width: `${pct}%` }} /></span>
              </span>
              <span className="text-[13px] text-ink-2">{CART_STATUS_TEXT[c.status]}</span>
              <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${isLow ? "bg-warning-tint text-ink ring-1 ring-warning/30" : c.status === "charging" ? "bg-info-tint text-ink" : "bg-surface text-muted"}`}>
                {isLow ? "Below reserve: no new trips" : c.status === "charging" ? "Charging" : "Above reserve"}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}


/**
 * Campus Flow Shield: plain, rule-based checks on the live state that point at where the service is
 * under pressure right now. Not a forecast and not automatic: each line says which rule produced it.
 */
export function FlowShieldPanel({ data, campus }: { data: StateSnapshot; campus: CampusConfig }) {
  const waiting = data.requests.filter((r) => r.status === "requested");
  const idle = data.carts.filter((c) => c.status === "idle" && c.batteryPercent >= SETTINGS.batteryReservePercent);
  const low = data.carts.filter((c) => c.batteryPercent < SETTINGS.batteryReservePercent);
  const byPickup = new Map<string, number>();
  for (const r of data.requests) if (["requested", "assigned", "arriving"].includes(r.status)) byPickup.set(r.pickupId, (byPickup.get(r.pickupId) ?? 0) + 1);
  const rush = [...byPickup.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  const alerts: { tone: "warning" | "info"; text: string; rule: string }[] = [];
  if (waiting.length > idle.length) alerts.push({ tone: "warning", text: `${waiting.length} request${waiting.length === 1 ? " is" : "s are"} waiting and ${idle.length === 0 ? "no cart is" : `only ${idle.length} cart${idle.length === 1 ? " is" : "s are"}`} idle above the reserve. Dispatch the oldest first; Shared requests may still join a running trip.`, rule: "waiting requests > idle carts above the reserve" });
  for (const [loc, n] of rush) alerts.push({ tone: "warning", text: `Rush at ${locationName(campus, loc)}: ${n} riders are waiting or about to be picked up there.`, rule: "2 or more active rides from one pickup point" });
  if (low.length && waiting.length) alerts.push({ tone: "info", text: `${low.map((c) => c.label).join(", ")} cannot take new trips while ${low.length === 1 ? "its battery is" : "their batteries are"} below the reserve.`, rule: `battery below ${SETTINGS.batteryReservePercent}% while requests wait` });
  return (
    <Card id="ops-flow" className="scroll-mt-24 flex flex-col gap-3 p-4" role="region" aria-labelledby="flow-title" data-testid="flow-shield">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="flow-title" className="text-[17px] font-extrabold">Campus Flow Shield</h2>
        <span className="text-[13px] text-muted">Rule-based checks on the live state · no predictions</span>
      </div>
      {alerts.length === 0 ? (
        <p className="rounded-tile bg-success-tint px-3 py-2 text-[14px] text-ink" data-testid="flow-clear">No pressure points right now: waiting requests are covered by idle carts and no pickup point has a queue.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {alerts.map((a, i) => (
            <li key={i} className={`rounded-tile px-3 py-2 text-[14px] text-ink ${a.tone === "warning" ? "bg-warning-tint" : "bg-info-tint"}`} data-testid="flow-alert">
              {a.text}
              <span className="mt-0.5 block text-[13px] text-ink-2">Rule: {a.rule}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
