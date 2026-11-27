import type { HTMLAttributes } from "react";

/** A card marks one object (a ride, a cart, a trip, a panel): white, 12px radius, thin line, flat. */
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`rounded-card bg-card ring-1 ring-line ${className}`} />;
}
