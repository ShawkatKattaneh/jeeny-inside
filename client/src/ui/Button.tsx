import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Full-width magenta pill, one per screen ("Request cart", "Join ride", "Boarded"). */
export function PrimaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`h-button w-full rounded-full bg-brand px-6 text-base font-bold text-white transition active:scale-[0.99] active:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${className}`}
    />
  );
}

/** Round white button with a thin gray ring (back, menu, notifications). */
export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-ink ring-1 ring-line transition active:bg-surface"
    >
      {children}
    </button>
  );
}
