import { etaText, useRideEta } from "../lib/rideEta";

/** ETA and leg progress on the Driver's dark panel (simulated driving, from the server). */
export function DriverEta({ requestId, revision, active }: { requestId: string; revision: number; active: boolean }) {
  const eta = useRideEta(requestId, revision, active);
  if (!eta) return null;
  const toPickup = eta.pickupSeconds !== null;
  const secs = toPickup ? eta.pickupSeconds! : eta.destinationSeconds;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="driver-eta">
      <p className="text-[13px] text-hero-muted">
        {secs === 0 ? (toPickup ? "At the pickup" : "At the destination") : <>{toPickup ? "Pickup" : "Destination"} in <b className="text-hero-fg">{etaText(secs)}</b> (estimated)</>}
      </p>
      {eta.legProgress !== null && (
        <span className="block h-1.5 overflow-hidden rounded-full bg-hero-track" role="progressbar" aria-label="Leg progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(eta.legProgress * 100)}>
          <span className="block h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(eta.legProgress * 100)}%` }} />
        </span>
      )}
    </div>
  );
}
