/**
 * Jeeny INSIDE lockup. An original mark (a route between two stops), not a Jeeny logo (D5).
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--color-brand)" />
      <path d="M9 22c0-6 14-6 14-12" stroke="white" strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <circle cx="9" cy="22" r="2.6" fill="white" />
      <circle cx="23" cy="10" r="2.6" fill="white" />
    </svg>
  );
}

export function BrandLockup({ size = 32 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark size={size} />
      <span className="text-[1.15rem] font-extrabold tracking-tight">
        Jeeny <span className="text-brand">INSIDE</span>
      </span>
    </div>
  );
}
