import { useSyncExternalStore } from "react";
import type { CampusConfig, Persona, StateSnapshot } from "../../../shared/schemas";
import type { DriverActionController } from "../lib/driverActions";
import { ACTION_LABEL, STAGE_LABEL, type ActionBinding, type CartTrip, type RiderState, type SharedTripView } from "../lib/driverWork";
import { PrimaryButton } from "../ui/Button";
import { useFlashOnChange } from "../ui/useFlashOnChange";
import { useCurrentStageSuccess } from "./useCurrentStageSuccess";
import { Card } from "../ui/Card";
import { locationName } from "../student/format";
import { arrivalState, passengerOf } from "../lib/tapIn";
import { TapInBadge } from "./TapInBadge";
import { ActionBar, HeroPanel, StatusChips } from "./DriverChrome";

const RIDER_TEXT: Record<RiderState, string> = {
  waiting: "Waiting for pickup",
  on_board: "On board",
  dropped_off: "Dropped off",
  cancelled: "Cancelled",
};
const RIDER_TONE: Record<RiderState, string> = {
  waiting: "bg-card text-ink ring-1 ring-line",
  on_board: "bg-success-tint text-ink ring-1 ring-success/30",
  dropped_off: "bg-surface text-ink-2",
  cancelled: "bg-surface text-muted line-through",
};
/** Shape per rider state so it reads without colour: ring, filled square, outlined square, none. */
const RIDER_MARK: Record<RiderState, string> = {
  waiting: "before:inline-block before:h-2.5 before:w-2.5 before:rounded-full before:border-2 before:border-muted before:content-['']",
  on_board: "before:inline-block before:h-2.5 before:w-2.5 before:rounded-[2px] before:bg-success before:content-['']",
  dropped_off: "before:inline-block before:h-2.5 before:w-2.5 before:rounded-[2px] before:border-2 before:border-muted before:content-['']",
  cancelled: "",
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
  // Shared trips move stop by stop: a message belongs to the stage and the stop it was shown at.
  const stageKey = `${stage}:${shared.nextStop?.locationId ?? ""}`;
  const successNow = useCurrentStageSuccess(state, stageKey);
  const flash = useFlashOnChange(stageKey);
  const riderName = (requestId: string) => {
    const r = shared.riders.find((x) => x.requestId === requestId)?.request;
    const p = r ? personas.find((x) => x.id === r.studentId && x.role === "student") : undefined;
    return p ? `${p.name} (${requestId})` : requestId;
  };
  const isPending = (a: ActionBinding) => pending && state.binding.requestId === a.requestId && state.binding.action === a.action;
  const next = shared.nextStop;

  return (
    <section className="flex flex-col gap-3" role="region" aria-labelledby={`trip-${trip.id}`} data-testid="shared-trip">
      <HeroPanel>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] text-hero-muted">Trip assigned to your cart · {trip.id} · <b className="text-hero-fg">Shared</b></div>
            <h2 id={`trip-${trip.id}`} className={`-mx-1 mt-0.5 rounded-md px-1 text-[26px] font-extrabold leading-tight tracking-tight ${flash}`} data-testid="trip-stage">
              {STAGE_LABEL[stage]}{next && (stage === "to_stop" || stage === "at_stop") ? `: ${locationName(campus, next.locationId)}` : ""}
            </h2>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[13px]">
          <div className="rounded-tile bg-hero-track/60 px-3 py-2">
            <div className="text-hero-muted">Seats</div>
            <div className="text-[15px] font-bold text-hero-fg" data-testid="shared-committed">{shared.committed}{shared.seats !== null ? ` of ${shared.seats}` : ""} seats committed</div>
          </div>
          <div className="rounded-tile bg-hero-track/60 px-3 py-2">
            <div className="text-hero-muted">Riders</div>
            <div className="text-[15px] font-bold text-hero-fg" data-testid="shared-onboard">{shared.onBoard} on board</div>
          </div>
        </div>
      </HeroPanel>

      <Card className="p-4">
        <h3 className="mb-2 text-[15px] font-bold text-ink">Stops, in the server's order</h3>
        <ol className="flex flex-col gap-1.5" data-testid="shared-stops">
          {shared.stops.map((s) => (
            <li key={s.index} className={`rounded-tile px-3 py-2 text-[15px] ring-1 ${s.status === "next" ? "bg-brand-tint ring-2 ring-brand" : "ring-line"} ${s.status === "done" ? "text-muted" : ""}`} aria-current={s.status === "next" ? "step" : undefined} data-testid="shared-stop">
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
      </Card>

      <Card className="overflow-hidden">
        <h3 className="px-4 pb-1 pt-3 text-[15px] font-bold text-ink">Riders</h3>
        <ul className="flex flex-col divide-y divide-line" data-testid="shared-riders">
          {shared.riders.map((r) => (
            <li key={r.requestId} className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[15px]" data-testid="shared-rider">
              <span className="min-w-0">
                <span className="font-semibold">{riderName(r.requestId)}</span>
                <span className="block text-[13px] text-muted">
                  {r.state === "cancelled"
                    ? "Cancelled before pickup: nothing to do"
                    : r.request ? `${locationName(campus, r.request.pickupId)} → ${locationName(campus, r.request.destinationId)}` : "Not in the live state"}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-y-1">
                {r.request && <TapInBadge arrival={arrivalState(r.request, passengerOf(trip, r.requestId))} />}
                <span className={`ml-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-bold ${RIDER_TONE[r.state]} ${RIDER_MARK[r.state]}`} data-testid={`rider-state-${r.requestId}`}>{RIDER_TEXT[r.state]}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <StatusChips items={[["Trip", trip.status], ["Cart", cart?.status ?? "unknown"]]} />

      {forThisTrip && state.status === "error" && (
        <p role="alert" className="rounded-tile bg-danger-tint px-3 py-2 text-sm text-ink" data-testid="action-error">
          {ACTION_LABEL[state.binding.action]} for {state.binding.requestId} failed: {state.message}
        </p>
      )}
      {forThisTrip && state.status === "success" && successNow && (
        <p role="status" className="rounded-tile bg-success-tint px-3 py-2 text-sm text-ink" data-testid="action-success">
          {state.binding.requestId}: {state.message}
        </p>
      )}
      <p className="text-[13px] text-muted">Riders join a shared trip only through dispatch, and only before anyone has boarded.</p>

      <ActionBar>
        {view.actions.length > 0 ? (
          view.actions.map((a) => (
            <PrimaryButton size="lg" key={`${a.action}-${a.requestId}`} type="button" disabled={pending} aria-busy={isPending(a)} onClick={() => void actions.submit(a)} data-testid="trip-action">
              {isPending(a) ? "Sending…" : a.action === "start" ? ACTION_LABEL.start : `${ACTION_LABEL[a.action]}: ${riderName(a.requestId)}`}
            </PrimaryButton>
          ))
        ) : (
          <p className="rounded-tile bg-surface px-3 py-2.5 text-center text-sm text-ink-2" data-testid="trip-unavailable">{unavailable}</p>
        )}
        {pending && <p className="text-center text-[13px] text-muted" role="status">Waiting for the server to confirm…</p>}
      </ActionBar>
    </section>
  );
}
