import { useEffect, useRef, type ReactNode } from "react";
import type { DriverStage } from "../lib/driverWork";

const STEPS: { stage: DriverStage; label: string }[] = [
  { stage: "planned", label: "Assigned" },
  { stage: "to_pickup", label: "To pickup" },
  { stage: "at_pickup", label: "At pickup" },
  { stage: "to_destination", label: "On board" },
  { stage: "at_destination", label: "At drop-off" },
];

/** Solo trip progress on the dark next-step panel. Steps are marked done only up to the server's stage. */
export function HeroSteps({ stage }: { stage: DriverStage }) {
  const current = STEPS.findIndex((s) => s.stage === stage);
  if (current === -1) return null;
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Trip progress">
      {STEPS.map((s, i) => (
        <li key={s.stage} className="flex flex-col items-center gap-1.5 text-center" aria-current={i === current ? "step" : undefined}>
          <span className={`h-1.5 w-full rounded-full ${i <= current ? "bg-brand" : "bg-hero-track"}`} aria-hidden="true" />
          {/* Wraps only between words ("At" / "drop-off"), never inside "drop-off" (non-breaking hyphen). */}
          <span className={`text-[13px] leading-tight [overflow-wrap:normal] [word-break:keep-all] ${i === current ? "font-bold text-hero-fg" : "text-hero-muted"}`}>
            {s.label.replace(/-/g, "\u2011")}
            <span className="sr-only">{i < current ? " (done)" : i === current ? " (current)" : " (not yet)"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The dark ink next-step panel at the top of a trip. It stays a distinct raised panel in dark mode. */
export function HeroPanel({ children }: { children: ReactNode }) {
  return <div className="on-hero flex flex-col gap-4 rounded-card bg-hero p-4 text-hero-fg shadow-float ring-1 ring-hero-ring">{children}</div>;
}

/** The three (or two) separate server statuses, as plain labelled chips. */
export function StatusChips({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-[13px]" aria-label="Server statuses">
      {items.map(([k, v]) => (
        <span key={k} className="rounded-full bg-surface px-2.5 py-1 text-ink-2 ring-1 ring-line">{k}: <b className="text-ink">{v}</b></span>
      ))}
    </div>
  );
}

/**
 * Driver Mode's fixed bottom action bar: solid, inside the phone column, with the next step the server
 * would accept. It publishes its height (--driver-bar-h) so the page reserves the same space and the bar
 * never covers content.
 */
export function ActionBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty("--driver-bar-h", `${el.offsetHeight}px`);
    set();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty("--driver-bar-h");
    };
  }, []);
  return (
    <div
      ref={ref}
      className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-w-[430px] flex-col gap-2 border-t border-line bg-card px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-bar"
      data-testid="driver-action-bar"
    >
      {children}
    </div>
  );
}
