import { useSyncExternalStore } from "react";
import type { CampusConfig, Persona, StateSnapshot } from "../../../shared/schemas";
import type { DriverActionController } from "../lib/driverActions";
import { ACTION_LABEL, STAGE_LABEL, type ActionBinding, type CartTrip, type RiderState, type SharedTripView } from "../lib/driverWork";
import { PrimaryButton } from "../ui/Button";
import { Card } from "../ui/Card";
import { locationName } from "../student/format";
import { arrivalState, passengerOf } from "../lib/tapIn";
import { TapInBadge } from "./TapInBadge";

const RIDER_TEXT: Record<RiderState, string> = {
  waiting: "Waiting for pickup",
  on_board: "On board",
  dropped_off: "Dropped off",
  cancelled: "Cancelled",
};
const RIDER_TONE: Record<RiderState, string> = {
  waiting: "bg-surface text-ink",
  on_board: "bg-green-50 text-ink",
  dropped_off: "bg-surface text-muted",
  cancelled: "bg-surface text-muted line-through",
};

/**
 * Phase 4: a shared trip of the driver's cart. The server's ordered stops, each rider's own state (from
 * the trip's passenger flags), committed riders against seats, and one button per rider the server
 * would board or drop off at the current stop. Every button sends through the action controller for
 * that exact request; the card changes only when the server's update arrives.
 * Riders are shown by demo persona name (exact id match only) and request id: what boarding needs.
 */
export function SharedTripCard({ view, shared, campus, personas, data, actions }: {
  view: CartTrip;
  shared: SharedTripView;
  campus: CampusConfig;
  personas: Persona[];
  data: StateSnapshot;
  actions: DriverActionController;
}) {
  const state = useSyncExternalStore(actions.subscribe, actions.getState, actions.getState);
  const { trip, stage, unavailable } = view;
  const cart = data.carts.find((c) => c.id === trip.cartId);
  const pending = state.status === "pending";
  const forThisTrip = state.status !== "idle" && state.binding.tripId === trip.id;
  const riderName = (requestId: string) => {
    const r = shared.riders.find((x) => x.requestId === requestId)?.request;
    const p = r ? personas.find((x) => x.id === r.studentId && x.role === "student") : undefined;
    return p ? `${p.name} (${requestId})` : requestId;
  };
  const isPending = (a: ActionBinding) => pending && state.binding.requestId === a.requestId && state.binding.action === a.action;
  const next = shared.nextStop;

  return (
    <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby={`trip-${trip.id}`} data-testid="shared-trip">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] text-muted">Trip assigned to your cart · {trip.id} · <b className="text-brand">Shared</b></div>
          <h2 id={`trip-${trip.id}`} className="text-lg font-extrabold tracking-tight" data-testid="trip-stage">
            {STAGE_LABEL[stage]}{next && (stage === "to_stop" || stage === "at_stop") ? `: ${locationName(campus, next.locationId)}` : ""}
          </h2>
        </div>
        <div className="text-right text-[13px]">
          <div className="font-bold" data-testid="shared-committed">{shared.committed}{shared.seats !== null ? ` of ${shared.seats}` : ""} seats committed</div>
          <div className="text-muted" data-testid="shared-onboard">{shared.onBoard} on board</div>
        </div>
      </div>

      <div>
        <h3 className="mb-1 text-[13px] font-bold text-muted">Stops, in the server's order</h3>
        <ol className="flex flex-col gap-1" data-testid="shared-stops">
          {shared.stops.map((s) => (
            <li key={s.index} className={`rounded-tile px-3 py-1.5 text-sm ring-1 ${s.status === "next" ? "bg-brand-tint ring-brand" : "ring-line"} ${s.status === "done" ? "text-muted" : ""}`} aria-current={s.status === "next" ? "step" : undefined} data-testid="shared-stop">
              <span className="font-semibold">{s.index + 1}. {locationName(campus, s.locationId)}</span>
              <span className="ml-2 text-[13px] text-muted">
                {s.status === "done" ? "done" : s.status === "next" ? (shared.atNextStop ? "cart is here" : "next") : ""}
              </span>
              <span className="block text-[13px]">
                {s.alight.length > 0 && <>Drop off {s.alight.map(riderName).join(", ")}. </>}
                {s.board.length > 0 && <>Pick up {s.board.map(riderName).join(", ")}.</>}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="mb-1 text-[13px] font-bold text-muted">Riders</h3>
        <ul className="flex flex-col gap-1" data-testid="shared-riders">
          {shared.riders.map((r) => (
            <li key={r.requestId} className="flex flex-wrap items-center justify-between gap-2 rounded-tile bg-surface px-3 py-1.5 text-sm" data-testid="shared-rider">
              <span className="min-w-0">
                <span className="font-semibold">{riderName(r.requestId)}</span>
                <span className="block text-[13px] text-muted">
                  {r.state === "cancelled"
                    ? "Cancelled before pickup: nothing to do"
                    : r.request ? `${locationName(campus, r.request.pickupId)} → ${locationName(campus, r.request.destinationId)}` : "Not in the live state"}
                </span>
              </span>
              <span className="flex items-center">
                {r.request && <TapInBadge arrival={arrivalState(r.request, passengerOf(trip, r.requestId))} />}
                <span className={`ml-2 rounded-full px-2 py-0.5 text-[13px] font-bold ${RIDER_TONE[r.state]}`} data-testid={`rider-state-${r.requestId}`}>{RIDER_TEXT[r.state]}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[13px]" aria-label="Server statuses">
        <span className="rounded-full bg-surface px-2 py-0.5 text-muted">Trip: <b className="text-ink">{trip.status}</b></span>
        <span className="rounded-full bg-surface px-2 py-0.5 text-muted">Cart: <b className="text-ink">{cart?.status ?? "unknown"}</b></span>
      </div>

      {forThisTrip && state.status === "error" && (
        <p role="alert" className="rounded-tile bg-red-50 px-3 py-2 text-sm text-ink" data-testid="action-error">
          {ACTION_LABEL[state.binding.action]} for {state.binding.requestId} failed: {state.message}
        </p>
      )}
      {forThisTrip && state.status === "success" && (
        <p role="status" className="rounded-tile bg-green-50 px-3 py-2 text-sm text-ink" data-testid="action-success">
          {state.binding.requestId}: {state.message}
        </p>
      )}

      {view.actions.length > 0 ? (
        <div className="flex flex-col gap-2">
          {view.actions.map((a) => (
            <PrimaryButton key={`${a.action}-${a.requestId}`} type="button" disabled={pending} aria-busy={isPending(a)} onClick={() => void actions.submit(a)} data-testid="trip-action">
              {isPending(a) ? "Sending…" : a.action === "start" ? ACTION_LABEL.start : `${ACTION_LABEL[a.action]}: ${riderName(a.requestId)}`}
            </PrimaryButton>
          ))}
        </div>
      ) : (
        <p className="rounded-tile bg-surface px-3 py-2 text-sm text-muted" data-testid="trip-unavailable">{unavailable}</p>
      )}
      {pending && <p className="text-center text-[13px] text-muted" role="status">Waiting for the server to confirm…</p>}
      <p className="text-[13px] text-muted">Riders join a shared trip only through dispatch, and only before anyone has boarded.</p>
    </Card>
  );
}
