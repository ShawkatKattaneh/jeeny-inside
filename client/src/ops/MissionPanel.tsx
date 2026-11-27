import { useState } from "react";
import { SETTINGS } from "../../../shared/settings";
import { Card } from "../ui/Card";

interface PolicyResult {
  policy: "pooling_on" | "pooling_off"; completed: number; unserved: number; avgWaitSeconds: number | null; maxWaitSeconds: number | null;
  avgRideSeconds: number | null; cartDrivingSeconds: number; trips: number; sharedTrips: number; ridersOnSharedTrips: number; finishedAtSeconds: number;
}
interface MissionResult { options: { seed: number; requests: number; sharedShare: number }; carts: number; results: [PolicyResult, PolicyResult] }

const min = (s: number | null) => (s === null ? "None" : `${(s / 60).toFixed(1)} min`);
const ROWS: [string, (p: PolicyResult) => string, string][] = [
  ["Rides completed", (p) => `${p.completed}`, "Requests carried to drop-off within the run"],
  ["Not served", (p) => `${p.unserved}`, "Still waiting when the run ended"],
  ["Average wait", (p) => min(p.avgWaitSeconds), "Request to boarding, completed rides"],
  ["Longest wait", (p) => min(p.maxWaitSeconds), "Request to boarding"],
  ["Average ride", (p) => min(p.avgRideSeconds), "Boarding to drop-off"],
  ["Cart driving time", (p) => min(p.cartDrivingSeconds), "Sum over every trip"],
  ["Trips", (p) => `${p.trips}`, "Cart trips created"],
  ["Shared trips", (p) => `${p.sharedTrips} (${p.ridersOnSharedTrips} riders)`, "Trips that carried more than one request"],
];

/**
 * Mission Mode: the server runs one seeded scenario twice on a private copy of the campus and fleet, with
 * pooling on (the live engine) and off (every request solo), and reports what happened. The live rides are
 * never touched. Same seed, same numbers.
 */
export function MissionPanel() {
  const [seed, setSeed] = useState("7");
  const [requests, setRequests] = useState(12);
  const [share, setShare] = useState(0.5);
  const [state, setState] = useState<{ status: "idle" } | { status: "running" } | { status: "done"; result: MissionResult } | { status: "error"; message: string }>({ status: "idle" });
  const seedNum = Number(seed);
  const seedOk = Number.isInteger(seedNum) && seedNum >= 1 && seedNum <= 1_000_000;
  const run = async () => {
    setState({ status: "running" });
    try {
      const r = await fetch("/api/mission/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed: seedNum, requests, sharedShare: share }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
      setState({ status: "done", result: body as MissionResult });
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : "The scenario could not be run." });
    }
  };
  const field = "h-11 rounded-tile bg-surface px-3 text-sm font-semibold ring-1 ring-line";
  return (
    <Card id="ops-mission" className="scroll-mt-24 flex flex-col gap-3 p-4" role="region" aria-labelledby="mission-title" data-testid="mission-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="mission-title" className="text-[17px] font-extrabold">Mission Mode</h2>
        <span className="text-[13px] text-muted">Simulated scenario on a copy · live rides untouched</span>
      </div>
      <p className="text-[13px] text-ink-2">Runs the same seeded demand twice on this campus and fleet: with pooling (the live engine, Shared requests may join trips within the {SETTINGS.sharedMaxAddedDelayMinutes}-minute delay cap) and without (every request solo, same nearest-cart dispatch). The simulator performs each driver step as soon as the rules allow. Every figure is counted from that run.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Seed
          <input className={`${field} w-28`} inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value)} aria-invalid={!seedOk || undefined} />
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Requests
          <select className={field} value={requests} onChange={(e) => setRequests(Number(e.target.value))}>{[8, 12, 20, 30].map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold text-muted">Asking for Shared
          <select className={field} value={share} onChange={(e) => setShare(Number(e.target.value))}>{[[0, "None"], [0.5, "Half"], [1, "All"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <button type="button" onClick={run} disabled={!seedOk || state.status === "running"} data-testid="mission-run"
          className={`h-11 rounded-full px-5 text-sm font-bold ${state.status === "running" ? "cursor-progress bg-brand-press text-white" : seedOk ? "bg-brand text-white hover:bg-brand-press" : "cursor-not-allowed bg-surface text-muted ring-1 ring-inset ring-line"}`}>
          {state.status === "running" ? "Running…" : "Run scenario"}
        </button>
      </div>
      {!seedOk && <p className="text-[13px] text-danger-text">Seed must be a whole number from 1 to 1,000,000.</p>}
      {state.status === "error" && <p role="alert" className="rounded-tile bg-danger-tint px-3 py-2 text-[13px] text-ink">Couldn't run the scenario: {state.message}</p>}
      {state.status === "done" && (
        <div className="overflow-x-auto" data-testid="mission-results">
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="pb-2 text-left text-[13px] text-muted">Seed {state.result.options.seed} · {state.result.options.requests} requests · {state.result.carts} carts. Lower is better for waits and driving time.</caption>
            <thead className="bg-surface"><tr><th className="px-3 py-2 text-left text-[13px] font-semibold text-ink-2">Measure</th><th className="px-3 py-2 text-left text-[13px] font-semibold text-ink-2">Pooling on</th><th className="px-3 py-2 text-left text-[13px] font-semibold text-ink-2">Pooling off</th></tr></thead>
            <tbody className="divide-y divide-line">
              {ROWS.map(([label, f, hint]) => (
                <tr key={label}>
                  <td className="px-3 py-2 align-top"><b>{label}</b><div className="text-[13px] text-muted">{hint}</div></td>
                  <td className="px-3 py-2 align-top font-semibold tabular-nums" data-testid={`mission-on-${label}`}>{f(state.result.results[0])}</td>
                  <td className="px-3 py-2 align-top font-semibold tabular-nums">{f(state.result.results[1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
