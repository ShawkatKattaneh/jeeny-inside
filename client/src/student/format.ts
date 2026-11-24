import type { CampusConfig } from "../../../shared/schemas";

/** A simulated fare in JOD, as the server gave it ("0.25 JOD"). */
export function formatJod(amount: number): string {
  return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} JOD`;
}

/**
 * Request timestamps are simulated milliseconds since the server started (engine clock), not wall-clock
 * time, so they are shown as a simulation time ("sim 2:05").
 */
export function formatSimTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `sim ${h}:${String(m).padStart(2, "0")}:${s}` : `sim ${m}:${s}`;
}

export function locationName(campus: CampusConfig, id: string): string {
  return campus.locations.find((l) => l.id === id)?.name ?? id;
}
