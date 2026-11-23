import type { ReactNode } from "react";

/**
 * Integrity labels (Plan section 9). "Sample data" and "Simulated" are shown wherever they apply.
 */
const TONES = {
  sample: "bg-surface text-muted ring-line",
  simulated: "bg-amber-50 text-warning ring-amber-200",
  brand: "bg-brand-tint text-brand ring-pink-200",
  accent: "bg-accent-tint text-accent ring-teal-200",
} as const;

export function Badge({ tone = "sample", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${TONES[tone]}`}>
      {children}
    </span>
  );
}
