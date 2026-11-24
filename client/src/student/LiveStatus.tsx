import type { RealtimeStatus } from "../lib/realtimeStore";

const COPY: Record<RealtimeStatus, { text: string; dot: string }> = {
  live: { text: "Live", dot: "bg-success" },
  connecting: { text: "Connecting…", dot: "bg-warning" },
  resyncing: { text: "Syncing…", dot: "bg-warning" },
  offline: { text: "Offline, showing last known state", dot: "bg-danger" },
};

/** Connection state of the live ride updates, announced politely to screen readers. */
export function LiveStatus({ status }: { status: RealtimeStatus }) {
  const c = COPY[status];
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-xs font-semibold text-muted">
      <span className={`inline-block h-2 w-2 rounded-full ${c.dot}`} aria-hidden="true" />
      {c.text}
    </span>
  );
}
