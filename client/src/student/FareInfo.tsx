import { SETTINGS } from "../../../shared/settings";
import type { RideRequest } from "../../../shared/schemas";
import { Badge } from "../ui/Badge";
import { formatJod } from "./format";

/**
 * The fare for one ride. Before booking it is the approved demo rate (shared/settings.ts); after
 * booking it is the fare the server stored on the request. "Free loyalty ride" appears only when the
 * server's own freeLoyaltyRide flag says so; the client never awards one.
 */
export function FareLine({ request }: { request?: RideRequest }) {
  const free = request?.freeLoyaltyRide === true;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-sm text-muted">
        Fare <Badge tone="simulated" emphasis="strong">Simulated</Badge>
      </span>
      <span className="text-right">
        <span className="block text-base font-extrabold" data-testid="fare-amount">
          {free ? "Free" : formatJod(request ? request.fareJod : SETTINGS.fareJod)}
        </span>
        <span className="block text-[13px] text-muted">{free
            ? "Free loyalty ride (from the server)"
            : request?.status === "cancelled"
              ? "Quoted fare (ride cancelled, no payment)"
              : request
                ? "Fare on your request"
                : "Approved demo rate"}</span>
      </span>
    </div>
  );
}

/** The approved pricing rules, as an explanation only. Nothing here is calculated per student. */
export function PricingExplainer() {
  return (
    <details className="group rounded-tile bg-surface px-4 py-1 text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 font-semibold marker:hidden">
        How fares work <span className="text-[13px] font-normal text-muted">(demo pricing)</span>
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted">
        <li>Every ride has a simulated fare of {formatJod(SETTINGS.fareJod)}. No real payment is taken and no card details are collected.</li>
        <li>Loyalty rule: after {SETTINGS.loyaltyPaidRidesForFree} completed paid rides, the next one is free. Cancelled and free rides do not count.</li>
        <li>Shared rides cost the same {formatJod(SETTINGS.sharedFareJod)} per rider: each rider has their own fare, with no discount or surcharge.</li>
      </ul>
      <p className="mb-2 mt-2 text-[13px] font-semibold text-ink" data-testid="loyalty-limitation">
        Loyalty tracking is not active in this prototype yet, so no free ride is counted or awarded.
      </p>
    </details>
  );
}
