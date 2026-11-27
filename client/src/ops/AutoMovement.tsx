import { useEffect, useState } from "react";
import { AUTO_ADVANCE_SPEEDS, AutoAdvanceStatus } from "../../../shared/schemas";

async function getStatus(): Promise<AutoAdvanceStatus> {
  return AutoAdvanceStatus.parse(await (await fetch("/api/simulation/auto")).json());
}
async function setStatus(running: boolean, speed: number): Promise<AutoAdvanceStatus> {
  const r = await fetch("/api/simulation/auto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ running, speed }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
  return AutoAdvanceStatus.parse(await r.json());
}

/**
 * Simulated movement, run by the server: while on, the server moves every driving cart along its route
 * once a second (the same engine step as "Advance"), so every screen sees the same position. Carts still
 * wait at each stop for the driver's arrival, boarding and drop-off confirmations.
 */
export function AutoMovement({ revision }: { revision: number }) {
  const [status, setLocal] = useState<AutoAdvanceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    getStatus().then((s) => live && setLocal(s)).catch(() => live && setLocal(null));
    return () => { live = false; };
  }, [revision]);
  const apply = async (running: boolean, speed: number) => {
    setBusy(true); setError(null);
    try { setLocal(await setStatus(running, speed)); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't change the simulated movement."); } finally { setBusy(false); }
  };
  const running = status?.running ?? false;
  const speed = status?.speed ?? 1;
  return (
    <div className="flex flex-col gap-2 rounded-tile bg-surface px-3 py-3" data-testid="auto-movement">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[14px] font-bold text-ink">Simulated movement</span>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${running ? "bg-success-tint text-ink" : "bg-card text-ink-2 ring-1 ring-line"}`} data-testid="auto-state">
          <span className={`inline-block h-2 w-2 ${running ? "rounded-[2px] bg-success" : "rounded-full border-2 border-muted"}`} aria-hidden="true" />
          {status === null ? "Unknown" : running ? `Running · ${speed}×` : "Paused"}
        </span>
      </div>
      <p className="text-[13px] text-muted">The server moves driving carts along their routes once a second. Positions are simulated, not GPS. Carts stop at each stop for the driver.</p>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Movement speed">
        {AUTO_ADVANCE_SPEEDS.map((n) => (
          <button key={n} type="button" disabled={busy} aria-pressed={speed === n} onClick={() => apply(running, n)}
            className={`min-h-11 min-w-11 rounded-full px-3 text-[13px] ring-1 transition-colors duration-150 ${speed === n ? "bg-brand-tint font-bold text-ink ring-2 ring-brand" : "bg-card font-semibold text-ink-2 ring-line hover:bg-surface"}`}>
            {n}×
          </button>
        ))}
        <button type="button" disabled={busy || status === null} onClick={() => apply(!running, speed)} data-testid="auto-toggle"
          className={`ml-auto min-h-11 rounded-full px-4 text-sm font-bold transition-colors duration-150 ${running ? "bg-card text-ink ring-1 ring-line hover:bg-surface" : "bg-brand text-white hover:bg-brand-press"}`}>
          {running ? "Pause movement" : "Start movement"}
        </button>
      </div>
      {error && <p role="alert" className="rounded-tile bg-danger-tint px-3 py-2 text-[13px] text-ink">{error}</p>}
    </div>
  );
}
