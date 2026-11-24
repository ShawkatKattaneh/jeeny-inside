import { useId, useState, useSyncExternalStore } from "react";
import type { CampusConfig, Persona, StateSnapshot } from "../../../shared/schemas";
import { MAX_SIMULATION_STEP_SECONDS } from "../../../shared/schemas";
import type { AdvanceController, DispatchController } from "../lib/opsActions";
import { checkAdvanceSeconds } from "../lib/opsActions";
import { CART_STATUS_TEXT, REQUEST_STATUS_TEXT, TRIP_STATUS_TEXT, dispatchAvailability, type OpsMetrics } from "../lib/opsMetrics";
import type { DispatchSelection } from "../lib/rideApi";
import { Card } from "../ui/Card";
import { formatSimTime, locationName } from "../student/format";
import { cartWhere, driverText, simClock, studentText } from "./opsFormat";

export type Selected = { kind: "cart" | "request" | "trip"; id: string } | null;

// ---------- Metrics ----------

function Tile({ label, value, hint, testId }: { label: string; value: number | string; hint?: string; testId?: string }) {
  return (
    <div className="rounded-tile bg-surface px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-xl font-extrabold" data-testid={testId}>{value}</div>
      {hint && <div className="text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

function StatusRow<K extends string>({ title, counts, text, testPrefix }: { title: string; counts: Record<K, number>; text: Record<K, string>; testPrefix: string }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-bold text-muted">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {(Object.keys(text) as K[]).map((k) => (
          <li key={k} className={`rounded-full px-2.5 py-0.5 text-xs ${counts[k] ? "bg-ink text-white" : "bg-surface text-muted"}`} data-testid={`${testPrefix}-${k}`}>
            {text[k]} <b>{counts[k]}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every figure is a count over one snapshot; carts, requests and trips are counted separately. */
export function MetricsPanel({ m }: { m: OpsMetrics }) {
  return (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-label="Live counts">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Carts in fleet" value={m.carts.total} testId="m-carts" />
        <Tile label="Idle carts" value={m.carts.byStatus.idle} hint="Idle is a cart status, not a dispatch promise" testId="m-idle" />
        <Tile label="Requests awaiting dispatch" value={m.requests.awaitingDispatch} hint="Status: requested" testId="m-awaiting" />
        <Tile label="Active requests" value={m.requests.active} hint="Requested, assigned, arriving or on board" testId="m-active" />
        <Tile label="Passengers on board" value={`${m.carts.passengersOnBoard}/${m.carts.seats}`} hint="Sum over carts / total seats" testId="m-onboard" />
        <Tile label="Completed requests" value={m.requests.byStatus.completed} testId="m-completed" />
        <Tile label="Cancelled requests" value={m.requests.byStatus.cancelled} testId="m-cancelled" />
        <Tile label="Trips (all)" value={m.trips.total} testId="m-trips" />
      </div>
      <StatusRow title="Carts by cart status" counts={m.carts.byStatus} text={CART_STATUS_TEXT} testPrefix="cart" />
      <StatusRow title="Ride requests by request status" counts={m.requests.byStatus} text={REQUEST_STATUS_TEXT} testPrefix="req" />
      <StatusRow title="Trips by trip status" counts={m.trips.byStatus} text={TRIP_STATUS_TEXT} testPrefix="trip" />
    </Card>
  );
}

// ---------- Simulation ----------

const PRESETS = [5, 15, 30, 60, 120, 300];

/** Advance simulated time explicitly. The clock shown is the server's; a requested step is labelled as such. */
export function SimulationPanel({ data, advance }: { data: StateSnapshot; advance: AdvanceController }) {
  const state = useSyncExternalStore(advance.subscribe, advance.getState, advance.getState);
  const [value, setValue] = useState("30");
  const inputId = useId();
  const seconds = value.trim() === "" ? NaN : Number(value);
  const check = checkAdvanceSeconds(seconds);
  const pending = state.status === "pending";
  const moving = data.trips.filter((t) => t.status === "active" || t.status === "cancelling").length;

  return (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby="sim-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="sim-title" className="text-base font-extrabold">Simulation</h2>
        <span className="text-xs text-muted">Simulation time, not clock time</span>
      </div>
      <div className="rounded-tile bg-surface px-3 py-2">
        <div className="text-[11px] text-muted">Simulation clock (from the live state)</div>
        <div className="text-2xl font-extrabold tabular-nums" data-testid="sim-clock">{simClock(data.clockSeconds)}</div>
        <div className="text-[11px] text-muted">{moving} moving trip{moving === 1 ? "" : "s"}. Carts move only when you advance.</div>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preset durations">
        {PRESETS.map((p) => (
          <button key={p} type="button" disabled={pending} onClick={() => setValue(String(p))}
            className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${Number(value) === p ? "bg-ink text-white ring-ink" : "ring-line"}`}>
            {p < 60 ? `${p} s` : `${p / 60} min`}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor={inputId} className="mb-1 block text-xs font-semibold text-muted">Seconds to advance (more than 0, up to {MAX_SIMULATION_STEP_SECONDS})</label>
        <input id={inputId} type="number" inputMode="decimal" min={0} max={MAX_SIMULATION_STEP_SECONDS} step="any" value={value} disabled={pending}
          onChange={(e) => setValue(e.target.value)} aria-invalid={!check.ok || undefined}
          className="h-11 w-full rounded-tile bg-surface px-3 text-sm font-semibold ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand" />
        {!check.ok && <p className="mt-1 text-xs text-danger" data-testid="sim-invalid">{check.message}</p>}
      </div>
      <button type="button" disabled={pending || !check.ok} aria-busy={pending} onClick={() => void advance.submit(seconds)}
        className="h-11 rounded-full bg-brand px-4 text-sm font-bold text-white disabled:opacity-40" data-testid="sim-advance">
        {pending ? `Advancing ${state.seconds} s…` : check.ok ? `Advance ${check.seconds} s` : "Advance"}
      </button>
      {state.status === "success" && (
        <p role="status" className="rounded-tile bg-green-50 px-3 py-2 text-xs text-success" data-testid="sim-success">
          Requested +{state.seconds} s. Server confirmed simulation clock {simClock(state.clockSeconds)}.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-tile bg-red-50 px-3 py-2 text-xs text-danger" data-testid="sim-error">
          Not advanced: {state.message}
        </p>
      )}
    </Card>
  );
}

// ---------- Dispatch ----------

function SelectionTable({ selection }: { selection: DispatchSelection }) {
  return (
    <div className="text-xs">
      <p className="mb-1 text-muted">{selection.policy}</p>
      <ul className="flex flex-col gap-1">
        {selection.candidates.map((c) => (
          <li key={c.cartId} className="rounded-tile bg-white px-2 py-1 ring-1 ring-line">
            <b>{c.cartId}</b>{" "}
            {c.eligible
              ? <>rank {c.rank}{c.cartId === selection.selectedCartId ? " (selected)" : ""}: {Math.round(c.pickupEtaSeconds ?? 0)} s, {Math.round(c.pickupDistanceMeters ?? 0)} m to pickup</>
              : <span className="text-muted">not eligible: {c.excludedReason ?? c.excludedCode}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Requests awaiting dispatch (status "requested"). Whether a cart can take one is decided by the server
 * when asked; the panel shows the server's answer, including its explanation of every cart.
 */
export function DispatchPanel({ data, campus, personas, dispatch, onSelect }: { data: StateSnapshot; campus: CampusConfig; personas: Persona[]; dispatch: DispatchController; onSelect: (s: Selected) => void }) {
  const state = useSyncExternalStore(dispatch.subscribe, dispatch.getState, dispatch.getState);
  const waiting = data.requests.filter((r) => dispatchAvailability(r.status).canAsk).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const pending = state.status === "pending";

  return (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby="dispatch-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="dispatch-title" className="text-base font-extrabold">Dispatch</h2>
        <span className="text-xs text-muted">Deterministic engine, one request per action</span>
      </div>
      {waiting.length === 0 ? (
        <p className="rounded-tile bg-surface px-3 py-4 text-center text-sm text-muted" data-testid="dispatch-empty">No requests awaiting dispatch.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {waiting.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-tile bg-surface px-3 py-2 sm:flex-row sm:items-center" data-testid="dispatch-item">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect({ kind: "request", id: r.id })}>
                <span className="block text-sm font-bold">{r.id} · {studentText(r.studentId, personas)}</span>
                <span className="block truncate text-xs text-muted">{locationName(campus, r.pickupId)} → {locationName(campus, r.destinationId)} · {formatSimTime(r.createdAt)} · awaiting dispatch evaluation</span>
              </button>
              <button type="button" disabled={pending} aria-busy={pending && state.requestId === r.id} onClick={() => void dispatch.submit(r.id)}
                className="h-10 shrink-0 rounded-full bg-ink px-4 text-sm font-bold text-white disabled:opacity-40">
                {pending && state.requestId === r.id ? "Dispatching…" : `Dispatch ${r.id}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.status === "success" && (
        <div role="status" className="flex flex-col gap-2 rounded-tile bg-green-50 px-3 py-2 text-xs" data-testid="dispatch-success">
          <p className="text-sm font-semibold text-success">{state.requestId} dispatched to {state.result.cart.label} ({state.result.cart.id}) by the server.</p>
          <SelectionTable selection={state.result.selection} />
        </div>
      )}
      {state.status === "error" && (
        <div role="alert" className="flex flex-col gap-2 rounded-tile bg-red-50 px-3 py-2 text-xs" data-testid="dispatch-error">
          <p className="text-sm font-semibold text-danger">{state.requestId} not dispatched: {state.message}</p>
          {state.selection && <SelectionTable selection={state.selection} />}
        </div>
      )}
    </Card>
  );
}

// ---------- Tables ----------

const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted";
const td = "px-3 py-2 align-top";

export function FleetTable({ data, campus, personas, selected, onSelect }: { data: StateSnapshot; campus: CampusConfig; personas: Persona[]; selected: Selected; onSelect: (s: Selected) => void }) {
  return (
    <Card className="overflow-hidden" role="region" aria-labelledby="fleet-title">
      <h2 id="fleet-title" className="border-b border-line px-4 py-3 text-base font-extrabold">Fleet <span className="text-xs font-normal text-muted">({data.carts.length} carts, simulated)</span></h2>
      {data.carts.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No carts in the fleet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="bg-surface"><tr><th className={th}>Cart</th><th className={th}>Status</th><th className={th}>Driver</th><th className={th}>Battery</th><th className={th}>Range</th><th className={th}>On board</th><th className={th}>Location</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.carts.map((c) => (
                <tr key={c.id} className={selected?.kind === "cart" && selected.id === c.id ? "bg-brand-tint" : ""} data-testid="fleet-row">
                  <td className={td}><button type="button" className="font-bold underline-offset-2 hover:underline" onClick={() => onSelect({ kind: "cart", id: c.id })}>{c.label}</button><div className="text-[11px] text-muted">{c.id}</div></td>
                  <td className={td}>{CART_STATUS_TEXT[c.status]}</td>
                  <td className={td}>{driverText(c, personas)}</td>
                  <td className={td}>{Math.round(c.batteryPercent)}%</td>
                  <td className={td}>{c.rangeKm} km</td>
                  <td className={td}>{c.passengerCount}/{c.seats}</td>
                  <td className={td}>{cartWhere(c, campus)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function RidesTables({ data, campus, personas, selected, onSelect }: { data: StateSnapshot; campus: CampusConfig; personas: Persona[]; selected: Selected; onSelect: (s: Selected) => void }) {
  const requests = [...data.requests].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const trips = [...data.trips].sort((a, b) => (a.id < b.id ? 1 : -1));
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card className="overflow-hidden" role="region" aria-labelledby="req-title">
        <h2 id="req-title" className="border-b border-line px-4 py-3 text-base font-extrabold">Ride requests <span className="text-xs font-normal text-muted">(request status)</span></h2>
        {requests.length === 0 ? <p className="px-4 py-4 text-sm text-muted" data-testid="requests-empty">No ride requests yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead className="bg-surface"><tr><th className={th}>Request</th><th className={th}>Status</th><th className={th}>Route</th></tr></thead>
              <tbody className="divide-y divide-line">
                {requests.map((r) => (
                  <tr key={r.id} className={selected?.kind === "request" && selected.id === r.id ? "bg-brand-tint" : ""} data-testid="request-row">
                    <td className={td}><button type="button" className="font-bold hover:underline" onClick={() => onSelect({ kind: "request", id: r.id })}>{r.id}</button><div className="text-[11px] text-muted">{studentText(r.studentId, personas)}</div></td>
                    <td className={td}>{REQUEST_STATUS_TEXT[r.status]}</td>
                    <td className={td}>{locationName(campus, r.pickupId)} → {locationName(campus, r.destinationId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card className="overflow-hidden" role="region" aria-labelledby="trip-title">
        <h2 id="trip-title" className="border-b border-line px-4 py-3 text-base font-extrabold">Trips <span className="text-xs font-normal text-muted">(trip status)</span></h2>
        {trips.length === 0 ? <p className="px-4 py-4 text-sm text-muted" data-testid="trips-empty">No trips yet. A trip is created when a request is dispatched.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[24rem] text-sm">
              <thead className="bg-surface"><tr><th className={th}>Trip</th><th className={th}>Status</th><th className={th}>Cart</th><th className={th}>Request</th></tr></thead>
              <tbody className="divide-y divide-line">
                {trips.map((t) => (
                  <tr key={t.id} className={selected?.kind === "trip" && selected.id === t.id ? "bg-brand-tint" : ""} data-testid="trip-row">
                    <td className={td}><button type="button" className="font-bold hover:underline" onClick={() => onSelect({ kind: "trip", id: t.id })}>{t.id}</button></td>
                    <td className={td}>{TRIP_STATUS_TEXT[t.status]}</td>
                    <td className={td}>{t.cartId}</td>
                    <td className={td}>{t.passengers.map((p) => p.requestId).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------- Details ----------

export function DetailsPanel({ data, campus, personas, selected, onClear }: { data: StateSnapshot; campus: CampusConfig; personas: Persona[]; selected: Selected; onClear: () => void }) {
  if (!selected) {
    return <Card className="px-4 py-4 text-sm text-muted" data-testid="details-empty">Select a cart, request or trip to see its details.</Card>;
  }
  const rows: [string, string][] = [];
  let title = selected.id;
  if (selected.kind === "cart") {
    const c = data.carts.find((x) => x.id === selected.id);
    if (c) {
      const open = data.trips.find((t) => t.cartId === c.id && (t.status === "planned" || t.status === "active" || t.status === "cancelling"));
      title = `${c.label} (${c.id})`;
      rows.push(["Cart status", CART_STATUS_TEXT[c.status]], ["Driver", driverText(c, personas)], ["Battery", `${Math.round(c.batteryPercent)}%`], ["Range", `${c.rangeKm} km`],
        ["On board", `${c.passengerCount} of ${c.seats} seats`], ["Top speed", `${c.maxSpeedKmh} km/h`], ["Location", cartWhere(c, campus)], ["Open trip", open ? `${open.id} (${TRIP_STATUS_TEXT[open.status]})` : "None"], ["Simulated", c.simulated ? "Yes" : "No"]);
    }
  } else if (selected.kind === "request") {
    const r = data.requests.find((x) => x.id === selected.id);
    if (r) {
      const trip = data.trips.find((t) => t.passengers.some((p) => p.requestId === r.id));
      rows.push(["Request status", REQUEST_STATUS_TEXT[r.status]], ["Student", studentText(r.studentId, personas)], ["Pickup", locationName(campus, r.pickupId)], ["Destination", locationName(campus, r.destinationId)],
        ["Mode", r.mode], ["Fare", `${r.fareJod} JOD (simulated)`], ["Free loyalty ride", r.freeLoyaltyRide ? "Yes" : "No"], ["Trip", trip ? `${trip.id} (${TRIP_STATUS_TEXT[trip.status]}, ${trip.cartId})` : "None yet"],
        ["Created", formatSimTime(r.createdAt)], ["Updated", formatSimTime(r.updatedAt)], ["Dispatch", dispatchAvailability(r.status).canAsk ? "Awaiting dispatch evaluation" : (dispatchAvailability(r.status) as { reason: string }).reason]);
    }
  } else {
    const t = data.trips.find((x) => x.id === selected.id);
    if (t) {
      rows.push(["Trip status", TRIP_STATUS_TEXT[t.status]], ["Cart", t.cartId], ["Passengers", t.passengers.map((p) => `${p.requestId}${p.boarded ? " (boarded)" : " (not boarded)"}`).join(", ")],
        ["Stops", t.stops.map((s, i) => `${i + 1}. ${locationName(campus, s.locationId)}`).join("  ")], ["Next stop", t.stopIndex < t.stops.length ? locationName(campus, t.stops[t.stopIndex]!.locationId) : "All stops done"],
        ["Current leg", t.leg ? t.leg.locationIds.map((id) => locationName(campus, id)).join(" → ") : "None"]);
    }
  }
  return (
    <Card className="flex flex-col gap-2 p-4" role="region" aria-labelledby="details-title" data-testid="details">
      <div className="flex items-start justify-between gap-2">
        <h2 id="details-title" className="text-base font-extrabold">{title}</h2>
        <button type="button" onClick={onClear} className="rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-line">Close</button>
      </div>
      {rows.length === 0 ? <p className="text-sm text-muted">{selected.id} is no longer in the live state.</p> : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-words font-semibold">{v}</dd></div>
          ))}
        </dl>
      )}
    </Card>
  );
}
