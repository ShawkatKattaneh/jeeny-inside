import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { CampusConfig, Persona, StateSnapshot } from "../../../shared/schemas";
import { MAX_SIMULATION_STEP_SECONDS } from "../../../shared/schemas";
import { SETTINGS } from "../../../shared/settings";
import type { AdvanceController, DispatchController } from "../lib/opsActions";
import { checkAdvanceSeconds } from "../lib/opsActions";
import { CART_STATUS_TEXT, JOIN_EXCLUSION_TEXT, REQUEST_STATUS_TEXT, RIDER_STATE_TEXT, TRIP_STATUS_TEXT, dispatchAvailability, tripRiderCounts, type OpsMetrics } from "../lib/opsMetrics";
import { isSharedTrip } from "../lib/driverWork";
import type { DispatchResult, DispatchSelection, JoinCandidate } from "../lib/rideApi";
import { Card } from "../ui/Card";
import { formatSimTime, locationName } from "../student/format";
import { cartWhere, driverText, simClock, studentText } from "./opsFormat";
import { opsTapInText } from "../lib/tapIn";

export type Selected = { kind: "cart" | "request" | "trip"; id: string } | null;

// ---------- Metrics ----------

function Tile({ label, value, hint, testId }: { label: string; value: number | string; hint?: string; testId?: string }) {
  return (
    <div className="rounded-tile bg-surface px-3 py-2">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="text-xl font-extrabold" data-testid={testId}>{value}</div>
      {hint && <div className="text-[13px] text-muted">{hint}</div>}
    </div>
  );
}

function StatusRow<K extends string>({ title, counts, text, testPrefix }: { title: string; counts: Record<K, number>; text: Record<K, string>; testPrefix: string }) {
  return (
    <div>
      <h3 className="mb-1 text-[13px] font-bold text-muted">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {(Object.keys(text) as K[]).map((k) => (
          <li key={k} className={`rounded-full px-2.5 py-0.5 text-[13px] ${counts[k] ? "bg-ink text-white" : "bg-surface text-muted"}`} data-testid={`${testPrefix}-${k}`}>
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
    <Card id="ops-overview" className="scroll-mt-4 flex flex-col gap-3 p-4" role="region" aria-label="Live counts">
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
    <Card id="ops-simulation" className="scroll-mt-4 flex flex-col gap-3 p-4" role="region" aria-labelledby="sim-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="sim-title" className="text-base font-extrabold">Simulation</h2>
        <span className="text-[13px] text-muted">Simulation time, not clock time</span>
      </div>
      <div className="rounded-tile bg-surface px-3 py-2">
        <div className="text-[13px] text-muted">Simulation clock (from the live state)</div>
        <div className="text-2xl font-extrabold tabular-nums" data-testid="sim-clock">{simClock(data.clockSeconds)}</div>
        <div className="text-[13px] text-muted">{moving} moving trip{moving === 1 ? "" : "s"}. Carts move only when you advance.</div>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preset durations">
        {PRESETS.map((p) => (
          <button key={p} type="button" disabled={pending} onClick={() => setValue(String(p))}
            className={`min-h-11 rounded-full px-3 py-1 text-[13px] font-semibold ring-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${Number(value) === p ? "bg-ink text-white ring-ink" : "ring-line"}`}>
            {p < 60 ? `${p} s` : `${p / 60} min`}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor={inputId} className="mb-1 block text-[13px] font-semibold text-muted">Seconds to advance (more than 0, up to {MAX_SIMULATION_STEP_SECONDS})</label>
        <input id={inputId} type="number" inputMode="decimal" min={0} max={MAX_SIMULATION_STEP_SECONDS} step="any" value={value} disabled={pending}
          onChange={(e) => setValue(e.target.value)} aria-invalid={!check.ok || undefined}
          className="h-11 w-full rounded-tile bg-surface px-3 text-sm font-semibold ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand" />
        {!check.ok && <p className="mt-1 text-[13px] text-danger" data-testid="sim-invalid">{check.message}</p>}
      </div>
      <button type="button" disabled={pending || !check.ok} aria-busy={pending} onClick={() => void advance.submit(seconds)}
        className="h-11 rounded-full bg-brand px-4 text-sm font-bold text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" data-testid="sim-advance">
        {pending ? `Advancing ${state.seconds} s…` : check.ok ? `Advance ${check.seconds} s` : "Advance"}
      </button>
      {state.status === "success" && (
        <p role="status" className="rounded-tile bg-green-50 px-3 py-2 text-[13px] text-ink" data-testid="sim-success">
          Requested +{state.seconds} s. Server confirmed simulation clock {simClock(state.clockSeconds)}.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="rounded-tile bg-red-50 px-3 py-2 text-[13px] text-ink" data-testid="sim-error">
          Not advanced: {state.message}
        </p>
      )}
    </Card>
  );
}

// ---------- Dispatch ----------

/** Signed seconds for the server's delay figures (planned driving time); display only, never compared to a limit here. */
const signedSeconds = (n: number) => `${n > 0 ? "+" : ""}${Number(n.toFixed(1))} s`;

/** One open trip as the server's shared dispatch judged it. Every figure and reason comes from the server. */
function JoinCandidateRow({ c, campus, selectedTripId }: { c: JoinCandidate; campus: CampusConfig; selectedTripId: string | null | undefined }) {
  return (
    <li className="rounded-tile bg-white px-2 py-1 ring-1 ring-line" data-testid="join-candidate">
      <b>{c.tripId}</b>{c.cartId ? <> on {c.cartId}</> : null}{c.stage ? <span className="text-muted"> ({c.stage === "planned" ? "planned trip" : "moving, nobody on board"})</span> : null}{" "}
      {c.eligible ? (
        <>
          <span>can join: rank {c.rank}{c.tripId === selectedTripId ? " (joined)" : ""}</span>
          {c.stopLocationIds && <span className="block text-muted">Stops after joining: {c.stopLocationIds.map((id) => locationName(campus, id)).join(" → ")}</span>}
          {c.riders && (
            <span className="block text-muted">
              Added planned driving time vs riding alone (server figures):{" "}
              {c.riders.map((r) => `${r.requestId}${r.joining ? " (new)" : ""}: wait ${r.waitDelaySeconds === null ? "n/a (on board)" : signedSeconds(r.waitDelaySeconds)}, journey ${signedSeconds(r.journeyDelaySeconds)}`).join("; ")}
            </span>
          )}
        </>
      ) : (
        <span className="text-muted" data-testid="join-excluded">
          not joinable: {(c.excludedCode && JOIN_EXCLUSION_TEXT[c.excludedCode]) ?? c.excludedCode ?? "no reason given"}
          {c.excludedReason && <span className="block">Server: {c.excludedReason}</span>}
        </span>
      )}
    </li>
  );
}

/** The shared part of a selection (Phase 4): the outcome and every open trip the server checked. Nothing is re-ranked or re-checked here. */
function SharedSelection({ selection, campus }: { selection: DispatchSelection; campus: CampusConfig }) {
  const outcome = selection.outcome === "joined"
    ? `Joined ${selection.selectedTripId ?? "an existing trip"} on ${selection.selectedCartId ?? "its cart"}.`
    : selection.outcome === "new_cart"
      ? `No open trip could take it, so it got its own cart (${selection.selectedCartId}). Other shared riders may join that trip later.`
      : "Neither joined a trip nor got a cart.";
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="shared-selection">
      <p className="font-semibold" data-testid="shared-outcome">Shared ride: {outcome}</p>
      {selection.joinCandidates && selection.joinCandidates.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {selection.joinCandidates.map((c) => <JoinCandidateRow key={c.tripId} c={c} campus={campus} selectedTripId={selection.selectedTripId} />)}
        </ul>
      ) : (
        <p className="text-muted">No open trips to join.</p>
      )}
      {selection.maxAddedDelaySeconds !== undefined && <p className="text-muted">Delay limit used by the server: {selection.maxAddedDelaySeconds} s per rider, measured in planned driving time.</p>}
    </div>
  );
}

function SelectionTable({ selection, campus }: { selection: DispatchSelection; campus: CampusConfig }) {
  return (
    <div className="text-[13px]">
      <p className="mb-1 text-muted">{selection.policy}</p>
      {selection.mode === "shared" && <p className="mb-1 font-semibold">Carts checked for riding alone (the rank 1 cart gives the rider's solo baseline):</p>}
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
      {selection.mode === "shared" && <SharedSelection selection={selection} campus={campus} />}
    </div>
  );
}

/** The success line: a solo dispatch keeps its Phase 3 wording; a shared one names the server's outcome. */
function dispatchedText(requestId: string, result: DispatchResult): string {
  const cart = `${result.cart.label} (${result.cart.id})`;
  if (result.selection.outcome === "joined") return `${requestId} joined shared trip ${result.trip.id} on ${cart}, by the server.`;
  if (result.selection.outcome === "new_cart") return `${requestId} (shared) dispatched to ${cart} on a new trip, by the server.`;
  return `${requestId} dispatched to ${cart} by the server.`;
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
    <Card id="ops-dispatch" className="scroll-mt-4 flex flex-col gap-3 p-4" role="region" aria-labelledby="dispatch-title">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="dispatch-title" className="text-base font-extrabold">Dispatch</h2>
        <span className="text-[13px] text-muted">Deterministic engine, one request per action</span>
      </div>
      {waiting.length === 0 ? (
        <p className="rounded-tile bg-surface px-3 py-4 text-center text-sm text-muted" data-testid="dispatch-empty">No requests awaiting dispatch.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {waiting.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-tile bg-surface px-3 py-2 sm:flex-row sm:items-center" data-testid="dispatch-item">
              <button type="button" className="min-h-11 min-w-0 flex-1 rounded-tile text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => onSelect({ kind: "request", id: r.id })}>
                <span className="block text-sm font-bold">{r.id} · {studentText(r.studentId, personas)}{r.mode === "shared" && <span className="ml-1 text-[13px] text-brand">Shared</span>}</span>
                <span className="block truncate text-[13px] text-muted">{locationName(campus, r.pickupId)} → {locationName(campus, r.destinationId)} · {formatSimTime(r.createdAt)} · awaiting dispatch evaluation</span>
              </button>
              <button type="button" disabled={pending} aria-busy={pending && state.requestId === r.id} onClick={() => void dispatch.submit(r.id)}
                className="h-11 shrink-0 rounded-full bg-ink px-4 text-sm font-bold text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                {pending && state.requestId === r.id ? "Dispatching…" : `Dispatch ${r.id}`}
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.status === "success" && (
        <div role="status" className="flex flex-col gap-2 rounded-tile bg-green-50 px-3 py-2 text-[13px]" data-testid="dispatch-success">
          <p className="text-sm font-semibold text-ink">{dispatchedText(state.requestId, state.result)}</p>
          <SelectionTable selection={state.result.selection} campus={campus} />
        </div>
      )}
      {state.status === "error" && (
        <div role="alert" className="flex flex-col gap-2 rounded-tile bg-red-50 px-3 py-2 text-[13px]" data-testid="dispatch-error">
          <p className="text-sm font-semibold text-ink">{state.requestId} not dispatched: {state.message}</p>
          {state.selection && <SelectionTable selection={state.selection} campus={campus} />}
        </div>
      )}
    </Card>
  );
}

// ---------- Tables ----------

const th = "px-3 py-2 text-left text-[13px] font-semibold uppercase tracking-wide text-muted";
const td = "px-3 py-2 align-top";

export function FleetTable({ data, campus, personas, selected, onSelect }: { data: StateSnapshot; campus: CampusConfig; personas: Persona[]; selected: Selected; onSelect: (s: Selected) => void }) {
  return (
    <Card id="ops-fleet" className="scroll-mt-4 overflow-hidden" role="region" aria-labelledby="fleet-title">
      <h2 id="fleet-title" className="border-b border-line px-4 py-3 text-base font-extrabold">Fleet <span className="text-[13px] font-normal text-muted">({data.carts.length} carts, simulated)</span></h2>
      {data.carts.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No carts in the fleet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="bg-surface"><tr><th className={th}>Cart</th><th className={th}>Status</th><th className={th}>Driver</th><th className={th}>Battery</th><th className={th}>Range</th><th className={th}>On board</th><th className={th}>Location</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.carts.map((c) => (
                <tr key={c.id} className={selected?.kind === "cart" && selected.id === c.id ? "bg-brand-tint" : ""} data-testid="fleet-row">
                  <td className={`${td} border-l-4 ${selected?.kind === "cart" && selected.id === c.id ? "border-brand" : "border-transparent"}`}><button type="button" aria-pressed={selected?.kind === "cart" && selected.id === c.id} className="inline-flex min-h-11 items-center font-bold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => onSelect({ kind: "cart", id: c.id })}>{c.label}</button><div className={`text-[13px] ${selected?.kind === "cart" && selected.id === c.id ? "text-ink" : "text-muted"}`}>{c.id}</div></td>
                  <td className={td}>{CART_STATUS_TEXT[c.status]}</td>
                  <td className={td}>{driverText(c, personas)}</td>
                  <td className={td}>
                    {Math.round(c.batteryPercent)}%
                    {c.batteryPercent < SETTINGS.batteryReservePercent && (
                      <div className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[13px] font-semibold text-ink ring-1 ring-amber-200" data-testid="fleet-battery-low">
                        Below {SETTINGS.batteryReservePercent}% reserve
                      </div>
                    )}
                  </td>
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
      <Card id="ops-requests" className="scroll-mt-4 overflow-hidden" role="region" aria-labelledby="req-title">
        <h2 id="req-title" className="border-b border-line px-4 py-3 text-base font-extrabold">Ride requests <span className="text-[13px] font-normal text-muted">(request status)</span></h2>
        {requests.length === 0 ? <p className="px-4 py-4 text-sm text-muted" data-testid="requests-empty">No ride requests yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead className="bg-surface"><tr><th className={th}>Request</th><th className={th}>Status</th><th className={th}>Route</th></tr></thead>
              <tbody className="divide-y divide-line">
                {requests.map((r) => (
                  <tr key={r.id} className={selected?.kind === "request" && selected.id === r.id ? "bg-brand-tint" : ""} data-testid="request-row">
                    <td className={`${td} border-l-4 ${selected?.kind === "request" && selected.id === r.id ? "border-brand" : "border-transparent"}`}><button type="button" aria-pressed={selected?.kind === "request" && selected.id === r.id} className="inline-flex min-h-11 items-center font-bold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => onSelect({ kind: "request", id: r.id })}>{r.id}</button><div className="text-[13px] text-muted">{studentText(r.studentId, personas)}</div>{r.mode === "shared" && <div className="text-[13px] font-bold text-brand">Shared</div>}</td>
                    <td className={td}>{REQUEST_STATUS_TEXT[r.status]}</td>
                    <td className={td}>{locationName(campus, r.pickupId)} → {locationName(campus, r.destinationId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card id="ops-trips" className="scroll-mt-4 overflow-hidden" role="region" aria-labelledby="trip-title">
        <h2 id="trip-title" className="border-b border-line px-4 py-3 text-base font-extrabold">Trips <span className="text-[13px] font-normal text-muted">(trip status)</span></h2>
        {trips.length === 0 ? <p className="px-4 py-4 text-sm text-muted" data-testid="trips-empty">No trips yet. A trip is created when a request is dispatched.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[24rem] text-sm">
              <thead className="bg-surface"><tr><th className={th}>Trip</th><th className={th}>Status</th><th className={th}>Cart</th><th className={th}>Request</th></tr></thead>
              <tbody className="divide-y divide-line">
                {trips.map((t) => (
                  <tr key={t.id} className={selected?.kind === "trip" && selected.id === t.id ? "bg-brand-tint" : ""} data-testid="trip-row">
                    <td className={`${td} border-l-4 ${selected?.kind === "trip" && selected.id === t.id ? "border-brand" : "border-transparent"}`}><button type="button" aria-pressed={selected?.kind === "trip" && selected.id === t.id} className="inline-flex min-h-11 items-center font-bold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" onClick={() => onSelect({ kind: "trip", id: t.id })}>{t.id}</button>{isSharedTrip(data, t) && <div className="text-[13px] font-bold text-brand" data-testid="trip-shared">Shared</div>}</td>
                    <td className={td}>{TRIP_STATUS_TEXT[t.status]}</td>
                    <td className={td}>{t.cartId}</td>
                    <td className={td}>
                      {t.passengers.map((p) => p.requestId).join(", ")}
                      {isSharedTrip(data, t) && (() => {
                        const n = tripRiderCounts(t);
                        return <div className="text-[13px] text-muted" data-testid="trip-riders">{n.committed} committed · {n.onBoard} on board</div>;
                      })()}
                    </td>
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
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const title = titleRef.current;
    const card = title?.closest<HTMLElement>('[data-testid="details"]');
    if (!selected || !title || !card) return;
    const r = card.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight - 80) {
      card.scrollIntoView({ block: "start" });
      title.focus({ preventScroll: true });
    }
  }, [selected?.kind, selected?.id]);
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
      rows.push(["Cart status", CART_STATUS_TEXT[c.status]], ["Driver", driverText(c, personas)], ["Battery", `${Math.round(c.batteryPercent)}%${c.batteryPercent < SETTINGS.batteryReservePercent ? ` (below the ${SETTINGS.batteryReservePercent}% reserve: the engine assigns no new trips to this cart)` : ""}`], ["Range", `${c.rangeKm} km`],
        ["On board", `${c.passengerCount} of ${c.seats} seats`], ["Top speed", `${c.maxSpeedKmh} km/h`], ["Location", cartWhere(c, campus)], ["Open trip", open ? `${open.id} (${TRIP_STATUS_TEXT[open.status]})` : "None"], ["Simulated", c.simulated ? "Yes" : "No"]);
      if (open && isSharedTrip(data, open)) rows.push(["Committed riders", `${tripRiderCounts(open).committed} of ${c.seats} seats (shared trip ${open.id}; on board counts only riders who boarded)`]);
    }
  } else if (selected.kind === "request") {
    const r = data.requests.find((x) => x.id === selected.id);
    if (r) {
      const trip = data.trips.find((t) => t.passengers.some((p) => p.requestId === r.id));
      rows.push(["Request status", REQUEST_STATUS_TEXT[r.status]], ["Student", studentText(r.studentId, personas)], ["Pickup", locationName(campus, r.pickupId)], ["Destination", locationName(campus, r.destinationId)],
        ["Mode", r.mode], ["Fare", `${r.fareJod} JOD (simulated)`], ["Free loyalty ride", r.freeLoyaltyRide ? "Yes" : "No"], ["Trip", trip ? `${trip.id} (${TRIP_STATUS_TEXT[trip.status]}, ${trip.cartId})` : "None yet"],
        ["Created", formatSimTime(r.createdAt)], ["Updated", formatSimTime(r.updatedAt)], ["Dispatch", dispatchAvailability(r.status).canAsk ? "Awaiting dispatch evaluation" : (dispatchAvailability(r.status) as { reason: string }).reason]);
      // Phase 4 Tap-In: read-only, never verified presence or boarding.
      const tap = opsTapInText(r, trip?.passengers.find((p) => p.requestId === r.id) ?? null, (id) => locationName(campus, id));
      if (tap) rows.push(["Tap-In", tap]);
    }
  } else {
    const t = data.trips.find((x) => x.id === selected.id);
    if (t) {
      const shared = isSharedTrip(data, t);
      const riderText = (p: (typeof t.passengers)[number]) => RIDER_STATE_TEXT[p.cancelled ? "cancelled" : p.droppedOff ? "dropped_off" : p.boarded ? "on_board" : "waiting"];
      const counts = tripRiderCounts(t);
      const seats = data.carts.find((c) => c.id === t.cartId)?.seats;
      rows.push(["Trip status", TRIP_STATUS_TEXT[t.status]], ["Cart", t.cartId]);
      if (shared) rows.push(["Ride type", "Shared"], ["Riders", `${counts.committed} committed${seats !== undefined ? ` of ${seats} seats` : ""}, ${counts.onBoard} on board, ${counts.total} in total`]);
      rows.push(
        ["Passengers", shared
          ? t.passengers.map((p) => `${p.requestId} (${riderText(p)})`).join(", ")
          : t.passengers.map((p) => `${p.requestId}${p.boarded ? " (boarded)" : " (not boarded)"}`).join(", ")],
        ["Stops", shared
          ? t.stops.map((s, i) => `${i + 1}. ${locationName(campus, s.locationId)}${s.board.length ? ` [pick up ${s.board.join(", ")}]` : ""}${s.alight.length ? ` [drop off ${s.alight.join(", ")}]` : ""}`).join("  ")
          : t.stops.map((s, i) => `${i + 1}. ${locationName(campus, s.locationId)}`).join("  ")], ["Next stop", t.stopIndex < t.stops.length ? locationName(campus, t.stops[t.stopIndex]!.locationId) : "All stops done"],
        ["Current leg", t.leg ? t.leg.locationIds.map((id) => locationName(campus, id)).join(" → ") : "None"]);
      // Phase 4 Tap-In: one line per rider with a recorded check-in (read-only, not verified).
      const taps = t.passengers.flatMap((p) => {
        const r = data.requests.find((x) => x.id === p.requestId);
        const text = r ? opsTapInText(r, p, (id) => locationName(campus, id)) : null;
        return text ? [`${p.requestId}: ${text}`] : [];
      });
      if (taps.length) rows.push(["Tap-Ins", taps.join("; ")]);
    }
  }
  return (
    <Card className="flex flex-col gap-2 p-4" role="region" aria-labelledby="details-title" data-testid="details">
      <div className="flex items-start justify-between gap-2">
        <h2 id="details-title" ref={titleRef} tabIndex={-1} className="text-base font-extrabold">{title}</h2>
        <button type="button" onClick={onClear} className="min-h-11 rounded-full px-4 py-1 text-[13px] font-semibold ring-1 ring-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Close</button>
      </div>
      {rows.length === 0 ? <p className="text-sm text-muted">{selected.id} is no longer in the live state.</p> : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="break-words font-semibold">{v}</dd></div>
          ))}
        </dl>
      )}
      {selected.kind === "trip" && <TripPassengers data={data} campus={campus} personas={personas} tripId={selected.id} />}
    </Card>
  );
}

/**
 * O-12: one row per rider on the selected trip, from the trip's own passenger flags and the riders' requests.
 * Tap-In (arrival check-in, never verified) and the rider's boarding state are separate columns: a Tap-In
 * never means boarded. Read-only; nothing here is computed beyond what the live state already holds.
 */
function TripPassengers({ data, campus, personas, tripId }: { data: StateSnapshot; campus: CampusConfig; personas: Persona[]; tripId: string }) {
  const t = data.trips.find((x) => x.id === tripId);
  if (!t || t.passengers.length === 0) return null;
  return (
    <div className="mt-1 overflow-x-auto" data-testid="trip-passengers">
      <h3 className="mb-1 text-[13px] font-bold text-muted">Passengers on this trip</h3>
      <table className="w-full min-w-[30rem] text-left text-[13px]">
        <thead className="text-muted"><tr><th className="py-1 pr-2 font-semibold">Rider</th><th className="pr-2 font-semibold">Pickup → drop-off</th><th className="pr-2 font-semibold">Rider state</th><th className="font-semibold">Tap-In (check-in only)</th></tr></thead>
        <tbody>
          {t.passengers.map((p) => {
            const r = data.requests.find((x) => x.id === p.requestId);
            const state = RIDER_STATE_TEXT[p.cancelled ? "cancelled" : p.droppedOff ? "dropped_off" : p.boarded ? "on_board" : "waiting"];
            const tap = r ? opsTapInText(r, p, (id) => locationName(campus, id)) : null;
            return (
              <tr key={p.requestId} className="border-t border-line align-top" data-testid={`trip-passenger-${p.requestId}`}>
                <td className="py-1 pr-2"><b>{p.requestId}</b><div className="text-muted">{r ? studentText(r.studentId, personas) : "Not in the live state"}</div></td>
                <td className="pr-2">{r ? `${locationName(campus, r.pickupId)} → ${locationName(campus, r.destinationId)}` : "Unknown"}</td>
                <td className="pr-2 font-semibold">{state}</td>
                <td>{tap ?? "None"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
