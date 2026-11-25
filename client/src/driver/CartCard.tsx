import type { Cart, CampusConfig } from "../../../shared/schemas";
import { SETTINGS } from "../../../shared/settings";
import { CART_STATUS_LABEL } from "../lib/driverWork";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { locationName } from "../student/format";

/** The driver's cart exactly as the server reports it. Battery and range are the fleet file's values. */
export function CartCard({ cart, campus }: { cart: Cart; campus: CampusConfig }) {
  const where = describePosition(cart, campus);
  // Below the approved battery reserve (shared/settings.ts) the engine no longer assigns the cart.
  const low = cart.batteryPercent < SETTINGS.batteryReservePercent;
  return (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby="cart-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] text-muted">Your cart</div>
          <h2 id="cart-title" className="text-xl font-extrabold tracking-tight" data-testid="driver-cart">{cart.label}</h2>
          <div className="text-[13px] text-muted">{cart.id}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="rounded-full bg-surface px-3 py-1 text-[13px] font-bold text-ink" data-testid="cart-status">{CART_STATUS_LABEL[cart.status]}</span>
          {cart.simulated && <Badge tone="simulated" emphasis="strong">Simulated</Badge>}
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-tile bg-surface px-2 py-2">
          <dt className="text-[13px] text-muted">Battery</dt>
          <dd className="text-base font-extrabold" data-testid="cart-battery">{Math.round(cart.batteryPercent)}%</dd>
          <div className="mx-auto mt-1 h-1.5 w-full max-w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className={`h-full ${low ? "bg-warning" : "bg-success"}`} style={{ width: `${Math.max(0, Math.min(100, cart.batteryPercent))}%` }} />
          </div>
        </div>
        <div className="rounded-tile bg-surface px-2 py-2">
          <dt className="text-[13px] text-muted">Range</dt>
          <dd className="text-base font-extrabold">{cart.rangeKm} km</dd>
        </div>
        <div className="rounded-tile bg-surface px-2 py-2">
          <dt className="text-[13px] text-muted">On board</dt>
          <dd className="text-base font-extrabold" data-testid="cart-passengers">{cart.passengerCount}/{cart.seats}</dd>
        </div>
      </dl>
      {low && (
        <p className="rounded-tile bg-amber-50 px-3 py-2 text-sm text-ink" data-testid="cart-battery-low">
          Battery below the {SETTINGS.batteryReservePercent}% reserve: no new trips are assigned to this cart.
        </p>
      )}
      <p className="text-sm text-ink">{where}</p>
    </Card>
  );
}

function describePosition(cart: Cart, campus: CampusConfig): string {
  const pos = cart.position;
  if (pos.kind === "at") return `At ${locationName(campus, pos.locationId)}`;
  const path = campus.paths.find((p) => p.id === pos.pathId);
  if (!path) return "On a campus path";
  return `On the path between ${locationName(campus, path.from)} and ${locationName(campus, path.to)}`;
}
