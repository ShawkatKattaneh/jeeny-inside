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

/**
 * Opt-in `emphasis="strong"`: 13px ink text for readability; each tone keeps its background and ring.
 * Without it the badge renders exactly as before.
 */
const STRONG_TONES: Record<keyof typeof TONES, string> = {
  sample: "bg-surface text-ink ring-line",
  simulated: "bg-amber-50 text-ink ring-amber-200",
  brand: "bg-brand-tint text-ink ring-pink-200",
  accent: "bg-accent-tint text-ink ring-teal-200",
};

export function Badge({ tone = "sample", emphasis, children }: { tone?: keyof typeof TONES; emphasis?: "strong"; children: ReactNode }) {
  const strong = emphasis === "strong";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 ${strong ? "text-[13px]" : "text-[11px]"} font-semibold uppercase tracking-wide ring-1 ${strong ? STRONG_TONES[tone] : TONES[tone]}`}>
      {children}
    </span>
  );
}
