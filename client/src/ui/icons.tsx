const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const BackIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
);
export const ChevronIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
);
export const SearchIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);
