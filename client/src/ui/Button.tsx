import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Full-width magenta pill, one per screen ("Request a ride", "Board", "Drop off").
 * `size="lg"` (52px) is the Driver action size; the default is 48px.
 */
export function PrimaryButton({ className = "", size, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: "lg" }) {
  const busy = props["aria-busy"] === true || props["aria-busy"] === "true";
  return (
    <button
      {...props}
      className={`${size === "lg" ? "h-button-lg text-[17px]" : "h-button text-base"} w-full rounded-full px-6 font-bold transition-colors duration-150 ${actionTone(busy, !!props.disabled)} ${className}`}
    >
      {busy ? <BusyLabel>{children}</BusyLabel> : children}
    </button>
  );
}

/**
 * Colours for a magenta action. Sending: stays solid (pressed magenta) with a spinner, so the label stays
 * readable. Unavailable: a neutral grey pill with readable text, never a faded magenta one.
 */
export function actionTone(busy: boolean, disabled: boolean, idle = "bg-brand text-white hover:bg-brand-press active:bg-brand-press"): string {
  if (busy) return "cursor-progress bg-brand-press text-white";
  if (disabled) return "cursor-not-allowed bg-surface text-muted ring-1 ring-inset ring-line";
  return idle;
}

/** Spinner plus label, for an action that is waiting for the server. */
export function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center justify-center gap-2">
      <Spinner />
      {children}
    </span>
  );
}

export function Spinner() {
  return <span className="jeeny-spinner inline-block h-4 w-4 shrink-0 rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />;
}

/** White pill with a thin ring, for secondary actions next to a primary one. */
export function SecondaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-11 items-center justify-center rounded-full bg-card px-4 py-2 text-sm font-semibold text-ink ring-1 ring-line transition-colors duration-150 hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
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
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-card text-ink ring-1 ring-line transition-colors duration-150 hover:bg-surface active:bg-surface"
    >
      {children}
    </button>
  );
}
