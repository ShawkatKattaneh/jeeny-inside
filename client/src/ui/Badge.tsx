import type { ReactNode } from "react";

/**
 * Status and integrity labels. 13px, sentence case, ink text on a tint (AA everywhere), with a small
 * shape so the meaning does not depend on colour alone. "Sample data" and "Simulated" are integrity
 * labels (Plan section 9) and are shown wherever they apply.
 */
const TONES = {
  sample: { box: "bg-surface ring-line", mark: "border-2 border-muted rounded-full" },
  neutral: { box: "bg-surface ring-line", mark: "" },
  simulated: { box: "bg-warning-tint ring-warning/30", mark: "bg-warning rounded-full" },
  brand: { box: "bg-brand-tint ring-brand/30", mark: "bg-brand rounded-full" },
  accent: { box: "bg-accent-tint ring-accent/30", mark: "bg-accent rounded-full" },
  success: { box: "bg-success-tint ring-success/30", mark: "bg-success rounded-[2px]" },
  warning: { box: "bg-warning-tint ring-warning/30", mark: "bg-warning rounded-full" },
  danger: { box: "bg-danger-tint ring-danger/30", mark: "bg-danger rounded-[2px] rotate-45" },
  info: { box: "bg-info-tint ring-info/30", mark: "" },
} as const;

export type BadgeTone = keyof typeof TONES;

/** `emphasis` is kept for compatibility; every badge is now the readable 13px style. */
export function Badge({ tone = "sample", children }: { tone?: BadgeTone; emphasis?: "strong"; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-semibold leading-5 text-ink ring-1 ${t.box}`}>
      {tone === "info" ? <InfoMark /> : t.mark && <span className={`inline-block h-2 w-2 shrink-0 ${t.mark}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Triangle mark used for "Checked in (Tap-In)": a different shape from every other state. */
export function InfoMark() {
  return <span className="inline-block h-0 w-0 shrink-0 border-x-[5px] border-b-[9px] border-x-transparent border-b-info" aria-hidden="true" />;
}
