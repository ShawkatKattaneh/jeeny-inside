import { useSyncExternalStore } from "react";
import type { CampusConfig, Persona, StateSnapshot } from "../../../shared/schemas";
import type { DriverActionController } from "../lib/driverActions";
import { ACTION_LABEL, STAGE_LABEL, arrived, type CartTrip } from "../lib/driverWork";
import { DriverEta } from "./DriverEta";
import { PrimaryButton } from "../ui/Button";
import { useFlashOnChange } from "../ui/useFlashOnChange";
import { useCurrentStageSuccess } from "./useCurrentStageSuccess";
import { Card } from "../ui/Card";
import { formatJod, formatSimTime, locationName } from "../student/format";
import { SharedTripCard } from "./SharedTripCard";
import { arrivalState, passengerOf } from "../lib/tapIn";
import { TapInBadge } from "./TapInBadge";
import { ActionBar, HeroPanel, HeroSteps, StatusChips } from "./DriverChrome";

/**
 * The selected trip of the driver's cart: passenger, pickup, destination, the three separate statuses,
 * and the one next step the server would accept now. Buttons send through the action controller and
 * the card waits for the server's update to change.
 */
export function TripCard({ view, campus, personas, data, actions }: {
  view: CartTrip;
  campus: CampusConfig;
  /** Seeded demo personas from GET /api/personas, used only to show a name for an exactly matching studentId. */
  personas: Persona[];
  data: StateSnapshot;
  actions: DriverActionController;
}) {
  if (view.shared) return <SharedTripCard view={view} shared={view.shared} campus={campus} personas={personas} data={data} actions={actions} />;
  return <SoloTripCard view={view} campus={campus} personas={personas} data={data} actions={actions} />;
}

/** The Phase 3 solo trip card, unchanged. */
function SoloTripCard({ view, campus, personas, data, actions }: {
  view: CartTrip;
  campus: CampusConfig;
  personas: Persona[];
  data: StateSnapshot;
  actions: DriverActionController;
}) {
  const state = useSyncExternalStore(actions.subscribe, actions.getState, actions.getState);
  const { trip, request, next, unavailable, stage } = view;
  const cart = data.carts.find((c) => c.id === trip.cartId);
  const passenger = request ? personas.find((p) => p.id === request.studentId && p.role === "student") ?? null : null;
  const pending = state.status === "pending";
  const forThisTrip = state.status !== "idle" && state.binding.tripId === trip.id;
  const successNow = useCurrentStageSuccess(state, stage);
  const flash = useFlashOnChange(stage);

  // Where the cart is heading now, from the server's stage (no new data).
  const toward = !request ? null
    : stage === "planned" || stage === "to_pickup" || stage === "at_pickup" ? { label: "Pickup", where: locationName(campus, request.pickupId) }
    : stage === "to_destination" || stage === "at_destination" ? { label: "Drop-off", where: locationName(campus, request.destinationId) }
    : null;

  return (
    <section className="flex flex-col gap-3" role="region" aria-labelledby={`trip-${trip.id}`}>
      <HeroPanel>
        <div>
          <div className="text-[13px] text-hero-muted">Trip assigned to your cart · {trip.id}</div>
          <h2 id={`trip-${trip.id}`} className={`-mx-1 mt-0.5 rounded-md px-1 text-[28px] font-extrabold leading-tight tracking-tight ${flash}`} data-testid="trip-stage">{STAGE_LABEL[stage]}</h2>
          {toward && (
            <p className="mt-1 text-[15px] text-hero-muted">
              {toward.label}: <b className="font-bold text-hero-fg">{toward.where}</b>
              {arrived(trip) && (stage === "at_pickup" || stage === "at_destination") && <span className="ml-2 rounded-full bg-hero-track px-2 py-0.5 text-[13px] font-semibold text-hero-fg" data-testid="arrival-confirmed">Arrival confirmed</span>}
            </p>
          )}
          {request && <DriverEta requestId={request.id} revision={data.revision} active={trip.status === "active"} />}
        </div>
        <HeroSteps stage={stage} />
      </HeroPanel>

      <Card className="p-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[15px]">
          <dt className="text-muted">Passenger</dt>
          <dd className="font-bold" data-testid="trip-passenger">
            {request ? (passenger ? `${passenger.name} (${request.studentId})` : request.studentId) : "Not in the live state"}
          </dd>
          <dt className="text-muted">Pickup</dt>
          <dd className="font-semibold">
            {request ? locationName(campus, request.pickupId) : "Unknown"}
            {request && <TapInBadge arrival={arrivalState(request, passengerOf(trip, request.id))} />}
          </dd>
          <dt className="text-muted">Drop-off</dt>
          <dd className="font-semibold">{request ? locationName(campus, request.destinationId) : "Unknown"}</dd>
          {request && (
            <>
              <dt className="text-muted">Fare</dt>
              <dd>{request.freeLoyaltyRide ? "Free loyalty ride" : formatJod(request.fareJod)} <span className="text-[13px] text-muted">(simulated, no payment)</span></dd>
              <dt className="text-muted">Requested</dt>
              <dd>{request.id} · {formatSimTime(request.createdAt)}</dd>
            </>
          )}
        </dl>
      </Card>

      <StatusChips items={[["Ride", request?.status ?? "unknown"], ["Trip", trip.status], ["Cart", cart?.status ?? "unknown"]]} />

      {forThisTrip && state.status === "error" && (
        <p role="alert" className="rounded-tile bg-danger-tint px-3 py-2 text-sm text-ink" data-testid="action-error">
          {ACTION_LABEL[state.binding.action]} failed: {state.message}
        </p>
      )}
      {forThisTrip && state.status === "success" && successNow && (
        <p role="status" className="rounded-tile bg-success-tint px-3 py-2 text-sm text-ink" data-testid="action-success">
          {state.message}
        </p>
      )}

      <ActionBar>
        {next ? (
          <PrimaryButton
            size="lg"
            type="button"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void actions.submit(next)}
            data-testid="trip-action"
          >
            {pending ? "Sending…" : next.action === "arrive" ? (stage === "at_destination" ? "Arrived at destination" : "Arrived at pickup") : ACTION_LABEL[next.action]}
          </PrimaryButton>
        ) : (
          <p className="rounded-tile bg-surface px-3 py-2.5 text-center text-sm text-ink-2" data-testid="trip-unavailable">{unavailable}</p>
        )}
        {pending && <p className="text-center text-[13px] text-muted" role="status">Waiting for the server to confirm…</p>}
      </ActionBar>
    </section>
  );
}
