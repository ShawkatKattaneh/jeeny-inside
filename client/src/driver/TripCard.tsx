import { useSyncExternalStore } from "react";
import type { CampusConfig, Persona, StateSnapshot } from "../../../shared/schemas";
import type { DriverActionController } from "../lib/driverActions";
import { ACTION_LABEL, STAGE_LABEL, type CartTrip, type DriverStage } from "../lib/driverWork";
import { PrimaryButton } from "../ui/Button";
import { Card } from "../ui/Card";
import { formatJod, formatSimTime, locationName } from "../student/format";
import { SharedTripCard } from "./SharedTripCard";

const STEPS: { stage: DriverStage; label: string }[] = [
  { stage: "planned", label: "Assigned" },
  { stage: "to_pickup", label: "To pickup" },
  { stage: "at_pickup", label: "At pickup" },
  { stage: "to_destination", label: "On board" },
  { stage: "at_destination", label: "At drop-off" },
];

function Steps({ stage }: { stage: DriverStage }) {
  const current = STEPS.findIndex((s) => s.stage === stage);
  if (current === -1) return null;
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Trip progress">
      {STEPS.map((s, i) => (
        <li key={s.stage} className="flex flex-col items-center gap-1 text-center" aria-current={i === current ? "step" : undefined}>
          <span className={`h-1.5 w-full rounded-full ${i <= current ? "bg-brand" : "bg-line"}`} aria-hidden="true" />
          <span className={`text-[10px] leading-tight ${i === current ? "font-bold text-ink" : "text-muted"}`}>
            {s.label}
            <span className="sr-only">{i < current ? " (done)" : i === current ? " (current)" : " (not yet)"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

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

  return (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby={`trip-${trip.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted">Trip assigned to your cart · {trip.id}</div>
          <h2 id={`trip-${trip.id}`} className="text-lg font-extrabold tracking-tight" data-testid="trip-stage">{STAGE_LABEL[stage]}</h2>
        </div>
      </div>

      <Steps stage={stage} />

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted">Passenger</dt>
        <dd className="font-semibold" data-testid="trip-passenger">
          {request ? (passenger ? `${passenger.name} (${request.studentId})` : request.studentId) : "Not in the live state"}
        </dd>
        <dt className="text-muted">Pickup</dt>
        <dd className="font-semibold">{request ? locationName(campus, request.pickupId) : "Unknown"}</dd>
        <dt className="text-muted">Drop-off</dt>
        <dd className="font-semibold">{request ? locationName(campus, request.destinationId) : "Unknown"}</dd>
        {request && (
          <>
            <dt className="text-muted">Fare</dt>
            <dd>{formatJod(request.fareJod)} <span className="text-xs text-muted">(simulated, no payment)</span></dd>
            <dt className="text-muted">Requested</dt>
            <dd>{request.id} · {formatSimTime(request.createdAt)}</dd>
          </>
        )}
      </dl>

      <div className="flex flex-wrap gap-1.5 text-[11px]" aria-label="Server statuses">
        <span className="rounded-full bg-surface px-2 py-0.5 text-muted">Ride: <b className="text-ink">{request?.status ?? "unknown"}</b></span>
        <span className="rounded-full bg-surface px-2 py-0.5 text-muted">Trip: <b className="text-ink">{trip.status}</b></span>
        <span className="rounded-full bg-surface px-2 py-0.5 text-muted">Cart: <b className="text-ink">{cart?.status ?? "unknown"}</b></span>
      </div>

      {forThisTrip && state.status === "error" && (
        <p role="alert" className="rounded-tile bg-red-50 px-3 py-2 text-sm text-danger" data-testid="action-error">
          {ACTION_LABEL[state.binding.action]} failed: {state.message}
        </p>
      )}
      {forThisTrip && state.status === "success" && (
        <p role="status" className="rounded-tile bg-green-50 px-3 py-2 text-sm text-success" data-testid="action-success">
          {state.message}
        </p>
      )}

      {next ? (
        <PrimaryButton
          type="button"
          disabled={pending}
          aria-busy={pending}
          onClick={() => void actions.submit(next)}
          data-testid="trip-action"
        >
          {pending ? "Sending…" : ACTION_LABEL[next.action]}
        </PrimaryButton>
      ) : (
        <p className="rounded-tile bg-surface px-3 py-2 text-sm text-muted" data-testid="trip-unavailable">{unavailable}</p>
      )}
      {pending && <p className="text-center text-xs text-muted" role="status">Waiting for the server to confirm…</p>}
    </Card>
  );
}
