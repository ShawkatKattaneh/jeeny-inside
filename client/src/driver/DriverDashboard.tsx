import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Persona } from "../../../shared/schemas";
import { useCampus } from "../lib/campusContext";
import { createDriverActionController } from "../lib/driverActions";
import { STAGE_LABEL, driverCartLink, openTripsForCart, shownTrip } from "../lib/driverWork";
import { fetchPersonas } from "../lib/api";
import { useRealtime, useRealtimeStore } from "../lib/realtimeContext";
import { createDriverApi, type DriverApi } from "../lib/rideApi";
import { cartMapPoint } from "../lib/studentRides";
import { useApi } from "../lib/useApi";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { Card } from "../ui/Card";
import { LiveStatus } from "../student/LiveStatus";
import { CartCard } from "./CartCard";
import { TripCard } from "./TripCard";

/**
 * Driver Mode: the driver's cart (by the server's Cart.driverId), the open trips assigned to that cart,
 * and the next lifecycle step. Everything shown comes from the one realtime store.
 */
export function DriverDashboard({ persona, api: injectedApi, personas: injectedPersonas }: { persona: Persona; api?: DriverApi; personas?: Persona[] }) {
  const campus = useCampus();
  const store = useRealtimeStore();
  const realtime = useRealtime();
  const [api] = useState(() => injectedApi ?? createDriverApi());
  const loadedPersonas = useApi(fetchPersonas);
  const personas = injectedPersonas ?? (loadedPersonas.status === "ready" ? loadedPersonas.data : []);
  const actions = useMemo(
    () => createDriverActionController({ api, currentData: () => store.getState().data, resync: () => store.resync() }),
    [api, store],
  );
  const actionState = useSyncExternalStore(actions.subscribe, actions.getState, actions.getState);
  const [selectedCartId, setSelectedCartId] = useState<string | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  /** The last trip this screen showed, to report its final server status once it is no longer open. */
  const [lastTripId, setLastTripId] = useState<string | null>(null);

  const data = realtime.data;
  const link = data ? driverCartLink(data, persona) : null;
  const cart = link ? (link.carts.length === 1 ? link.carts[0]! : link.carts.find((c) => c.id === selectedCartId) ?? null) : null;
  const trips = data && cart ? openTripsForCart(data, cart.id) : [];
  const view = shownTrip(trips, selectedTripId);
  const shownId = view?.trip.id ?? null;

  useEffect(() => {
    if (shownId) setLastTripId(shownId);
  }, [shownId]);

  const finished = !view && lastTripId && data ? data.trips.find((t) => t.id === lastTripId && (t.status === "completed" || t.status === "cancelled")) ?? null : null;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Driver Mode</h1>
        <Badge>Demo persona</Badge>
      </div>
      <LiveStatus status={realtime.status} />
    </div>
  );

  if (!data || !link) {
    return (
      <>
        {header}
        <p className="rounded-tile bg-surface px-4 py-6 text-center text-sm text-muted" role="status">Loading the live fleet…</p>
      </>
    );
  }

  if (data.campusId !== campus.id) {
    return (
      <>
        {header}
        <p role="alert" className="rounded-tile bg-red-50 px-4 py-3 text-sm text-danger">
          The server is now running a different campus. Reload the page to continue.
        </p>
      </>
    );
  }

  const mismatchNote = link.mismatch && (
    <p className="rounded-tile bg-amber-50 px-4 py-3 text-xs text-warning" data-testid="cart-mismatch">
      Your demo profile lists {link.personaCartId}, but the live fleet {link.carts.length ? `assigns you ${link.carts.map((c) => c.id).join(", ")}` : "does not assign you any cart"}. Driver Mode follows the live fleet.
    </p>
  );

  if (link.carts.length === 0) {
    return (
      <>
        {header}
        {mismatchNote}
        <Card className="px-4 py-6 text-center text-sm" data-testid="no-cart">
          <p className="font-semibold">No cart is assigned to you</p>
          <p className="mt-1 text-muted">No cart in the live fleet has you ({persona.id}) as its driver, so there are no trips to show.</p>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      {mismatchNote}

      {link.carts.length > 1 && (
        <Card className="p-4">
          <label htmlFor="cart-select" className="mb-1 block text-xs font-semibold text-muted">The live fleet lists you as the driver of {link.carts.length} carts. Choose one.</label>
          <select
            id="cart-select"
            className="h-12 w-full rounded-tile bg-surface px-3 text-sm font-semibold ring-1 ring-line"
            value={selectedCartId ?? ""}
            onChange={(e) => { setSelectedCartId(e.target.value || null); setSelectedTripId(null); actions.reset(); }}
          >
            <option value="">Choose a cart</option>
            {link.carts.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.id})</option>)}
          </select>
        </Card>
      )}

      {cart && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-start">
          <section className="flex flex-col gap-3" aria-label="Your cart and trip">
            <CartCard cart={cart} campus={campus} />

            {finished && (
              <p role="status" className="rounded-tile bg-surface px-4 py-3 text-sm" data-testid="trip-finished">
                {finished.id} is {finished.status}.{" "}
                {actionState.status === "success" && actionState.binding.tripId === finished.id ? actionState.message : ""}
              </p>
            )}

            {trips.length === 0 ? (
              <Card className="px-4 py-6 text-center text-sm" data-testid="no-trip">
                <p className="font-semibold">No trip assigned to your cart</p>
                <p className="mt-1 text-muted">When a ride is dispatched to {cart.label}, it appears here.</p>
              </Card>
            ) : (
              <>
                {trips.length > 1 && (
                  <Card className="p-4" data-testid="trip-picker">
                    <p className="mb-2 text-xs font-semibold text-muted">{trips.length} open trips are assigned to {cart.label}. Choose the one to work on.</p>
                    <ul className="flex flex-col gap-2">
                      {trips.map((t) => (
                        <li key={t.trip.id}>
                          <button
                            type="button"
                            aria-pressed={view?.trip.id === t.trip.id}
                            disabled={actionState.status === "pending"}
                            onClick={() => { setSelectedTripId(t.trip.id); actions.reset(); }}
                            className={`flex w-full items-center justify-between rounded-tile px-3 py-2 text-left text-sm ring-1 ${view?.trip.id === t.trip.id ? "bg-brand-tint ring-brand" : "bg-surface ring-line"}`}
                          >
                            <span className="font-semibold">{t.trip.id}</span>
                            <span className="text-xs text-muted">{STAGE_LABEL[t.stage]}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                {view && <TripCard view={view} campus={campus} personas={personas} data={data} actions={actions} />}
              </>
            )}
          </section>

          <section aria-label="Campus map">
            <figure className="flex flex-col gap-2">
              <CampusMap
                campus={campus}
                overlay={{
                  // Shared trips (Phase 4): mark the stop the trip is serving now, as a pickup and/or a drop-off.
                  pickupId: view?.request?.pickupId ?? (view?.shared?.nextStop?.board.length ? view.shared.nextStop.locationId : null),
                  destinationId: view?.request?.destinationId ?? (view?.shared?.nextStop?.alight.length ? view.shared.nextStop.locationId : null),
                  routePathIds: view?.trip.leg?.pathIds ?? [],
                  cart: (() => {
                    const p = cartMapPoint(campus, cart.position);
                    return p ? { label: cart.label, point: p } : null;
                  })(),
                }}
              />
              <figcaption className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                {campus.fictional && <Badge>Fictional campus</Badge>}
                <span>Demo campus map: schematic, not to scale, not GPS. Your cart is shown at its simulated position; it moves only when the simulation advances.</span>
              </figcaption>
            </figure>
          </section>
        </div>
      )}
    </>
  );
}
