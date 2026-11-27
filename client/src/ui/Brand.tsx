/**
 * Jeeny INSIDE lockup. An original mark (a route between two stops), not a Jeeny logo (D5).
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="9" fill="var(--color-brand)" />
      <path d="M9 22c0-6 14-6 14-12" stroke="white" strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <circle cx="9" cy="22" r="2.6" fill="white" />
      <circle cx="23" cy="10" r="2.6" fill="white" />
    </svg>
  );
}

/**
 * `compact` (the app header): the word "Jeeny" is hidden below 400px so the mode switcher and the
 * persona name keep their room; the full name stays available to screen readers.
 */
export function BrandLockup({ size = 32, compact = false }: { size?: number; compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <BrandMark size={size} />
      <span className={`${compact ? "text-base" : "text-[1.15rem]"} whitespace-nowrap font-extrabold tracking-tight`}>
        <span className={compact ? "max-[399px]:sr-only" : ""}>Jeeny </span>
        <span className="text-brand-strong">INSIDE</span>
      </span>
    </div>
  );
}
