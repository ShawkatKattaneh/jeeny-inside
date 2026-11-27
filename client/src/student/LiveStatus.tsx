import type { RealtimeStatus } from "../lib/realtimeStore";

const COPY: Record<RealtimeStatus, { text: string; short: string; dot: string }> = {
  live: { text: "Live", short: "Live", dot: "bg-success" },
  connecting: { text: "Connecting…", short: "Connecting…", dot: "bg-warning" },
  resyncing: { text: "Syncing…", short: "Syncing…", dot: "bg-warning" },
  offline: { text: "Offline, showing last known state", short: "Offline", dot: "bg-danger rounded-[2px]" },
};

/** Full sentence for a status, for screens that show the compact chip and explain it elsewhere. */
export const liveStatusText = (s: RealtimeStatus) => COPY[s].text;

/**
 * Connection state of the live updates (the socket), announced politely to screen readers. "Live" means
 * the connection is up; the data it carries is still the simulated fleet.
 */
/**
 * `floating` (on the map): a compact one-line chip ("Offline"); the screen shows the full sentence
 * nearby and the chip still announces it to screen readers.
 */
export function LiveStatus({ status, floating = false }: { status: RealtimeStatus; floating?: boolean }) {
  const c = COPY[status];
  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold text-ink-2 ${floating ? "min-h-8 whitespace-nowrap bg-card shadow-float ring-1 ring-line" : "bg-surface"}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${c.dot}`} aria-hidden="true" />
      {floating && c.short !== c.text ? <><span aria-hidden="true">{c.short}</span><span className="sr-only">{c.text}</span></> : c.text}
    </span>
  );
}
