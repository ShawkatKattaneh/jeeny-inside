const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const BackIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
);
export const ChevronIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
);
export const ChevronDownIcon = () => (
  <svg {...base} width={16} height={16} aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);
export const SearchIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);
export const CheckIcon = () => (
  <svg {...base} width={18} height={18} strokeWidth={2.25} aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
);
/** Mode icons: a person (Student), a steering wheel (Driver), a grid (Operations). */
export const StudentIcon = () => (
  <svg {...base} width={18} height={18} aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);
export const DriverIcon = () => (
  <svg {...base} width={18} height={18} aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /><path d="M12 14.5V21M3.5 10l6 1.5M20.5 10l-6 1.5" /></svg>
);
export const OpsIcon = () => (
  <svg {...base} width={18} height={18} aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const HomeIcon = () => (
  <svg {...base} width={22} height={22} aria-hidden="true"><path d="M3 10.5L12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></svg>
);
export const RidesIcon = () => (
  <svg {...base} width={22} height={22} aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10h10M7 14h6" /></svg>
);
export const SwapIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4" /></svg>
);
