import { useEffect, useId, useState, type FormEvent } from "react";
import { bookingBlockReason, checkSelection, stopLocations } from "../lib/booking";
import { LOCATION_TYPE_LABEL } from "../lib/mapGeometry";
import { PrimaryButton } from "../ui/Button";
import { ChevronDownIcon, SwapIcon } from "../ui/icons";
import { FareLine } from "./FareInfo";
import { useBookingState, useStudent } from "./studentContext";

export interface Selection {
  pickupId: string;
  destinationId: string;
}

/**
 * Pickup and destination from the campus's stop locations, the fare, and one "Request a ride" action.
 * Selections live in the parent so the map can show them. The controller re-checks everything at the
 * moment of submission and ignores taps while a request is in flight.
 */
export function BookingPanel({ selection, onChange }: { selection: Selection; onChange: (s: Selection) => void }) {
  const { campus, persona, realtime, booking } = useStudent();
  const state = useBookingState(booking);
  const stops = stopLocations(campus);
  const pickupFieldId = useId();
  const destFieldId = useId();
  const messageId = useId();
  const modeHelpId = useId();
  // Phase 4: Solo stays the default; Shared only asks the server to consider combining rides.
  const [mode, setMode] = useState<"solo" | "shared">("solo");

  // A previous attempt's message should not follow the student back to this form later.
  useEffect(() => () => booking.reset(), [booking]);

  const check = checkSelection(campus, selection.pickupId, selection.destinationId);
  const blocked = bookingBlockReason(campus, realtime.data, persona.id);
  const submitting = state.status === "submitting";
  // Only show "choose a destination" style hints once the student has started choosing.
  const showCheck = !check.ok && (selection.pickupId !== "" || selection.destinationId !== "") && check.message;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void booking.submit({ studentId: persona.id, ...selection, mode });
  };

  const options = stops.map((l) => (
    <option key={l.id} value={l.id}>
      {l.name} ({LOCATION_TYPE_LABEL[l.type]})
    </option>
  ));
  const selectClass =
    "select-row h-11 w-full min-w-0 truncate rounded-[10px] pr-8 text-[15px] font-semibold text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-strong)] disabled:opacity-60";
  const canSwap = !submitting && (selection.pickupId !== "" || selection.destinationId !== "");

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-describedby={messageId}>
      <h2 className="text-[22px] font-extrabold tracking-tight">Where to?</h2>

      {/* Route card: pickup above destination, joined by the route line, with one swap control. */}
      <div className="relative rounded-card bg-surface py-1 pl-3 pr-16 ring-1 ring-line">
        <span className="absolute bottom-[34%] left-[1.3rem] top-[34%] border-l-2 border-dotted border-muted/60" aria-hidden="true" />
        <div className="flex items-center gap-3">
          <span className="relative z-10 inline-block h-3 w-3 shrink-0 rounded-full bg-surface ring-[3px] ring-brand" aria-hidden="true" />
          <div className="relative min-w-0 flex-1 py-1.5">
            <label htmlFor={pickupFieldId} className="block text-[13px] font-semibold text-muted">Pickup</label>
            <select
              id={pickupFieldId}
              className={selectClass}
              value={selection.pickupId}
              disabled={submitting}
              aria-invalid={showCheck && !check.ok && check.field === "pickupId" ? true : undefined}
              onChange={(e) => onChange({ ...selection, pickupId: e.target.value })}
            >
              <option value="">Choose pickup</option>
              {options}
            </select>
            <span className="pointer-events-none absolute bottom-[1.1rem] right-1 text-muted"><ChevronDownIcon /></span>
          </div>
        </div>
        <div className="ml-6 border-t border-line" aria-hidden="true" />
        <div className="flex items-center gap-3">
          <span className="relative z-10 inline-block h-3 w-3 shrink-0 rounded-[3px] bg-dropoff ring-[3px] ring-dropoff" aria-hidden="true" />
          <div className="relative min-w-0 flex-1 py-1.5">
            <label htmlFor={destFieldId} className="block text-[13px] font-semibold text-muted">Destination</label>
            <select
              id={destFieldId}
              className={selectClass}
              value={selection.destinationId}
              disabled={submitting}
              aria-invalid={showCheck && !check.ok && check.field === "destinationId" ? true : undefined}
              onChange={(e) => onChange({ ...selection, destinationId: e.target.value })}
            >
              <option value="">Choose destination</option>
              {options}
            </select>
            <span className="pointer-events-none absolute bottom-[1.1rem] right-1 text-muted"><ChevronDownIcon /></span>
          </div>
        </div>
        <button
          type="button"
          className="absolute right-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-card text-ink-2 shadow-float ring-1 ring-line transition-colors duration-150 hover:text-ink disabled:opacity-40"
          disabled={!canSwap}
          onClick={() => onChange({ pickupId: selection.destinationId, destinationId: selection.pickupId })}
        >
          <SwapIcon />
          <span className="sr-only">Swap pickup and destination</span>
        </button>
      </div>

      <fieldset className="flex flex-col gap-2" aria-describedby={modeHelpId}>
        <legend className="mb-2 text-[13px] font-semibold text-muted">Ride type</legend>
        <div className="grid grid-cols-2 gap-2" data-testid="mode-choice">
          {(["solo", "shared"] as const).map((m) => (
            <label
              key={m}
              className={`relative flex min-h-16 cursor-pointer items-center gap-3 rounded-card px-3 py-2.5 ring-1 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--brand-strong)] ${mode === m ? "bg-brand-tint ring-2 ring-brand" : "bg-card ring-line hover:bg-surface"}`}
            >
              <input type="radio" name="ride-mode" value={m} checked={mode === m} disabled={submitting} onChange={() => setMode(m)} className="h-5 w-5 shrink-0 accent-[var(--color-brand)]" />
              <span className="min-w-0">
                <span className="block text-[15px] font-bold text-ink">{m === "solo" ? "Solo" : "Shared"}</span>
                <span className="block text-[13px] text-muted">{m === "solo" ? "Just your ride" : "May share a cart"}</span>
              </span>
            </label>
          ))}
        </div>
        <p id={modeHelpId} className="text-[13px] leading-relaxed text-muted" data-testid="mode-help">
          {mode === "shared"
            ? "Shared may combine your ride with compatible rides on the same cart. A match is not guaranteed: it depends on the live carts and trips when your ride is dispatched. Same fare."
            : "Solo: a cart for your ride only."}
        </p>
      </fieldset>

      <div className="rounded-card bg-surface px-4 py-3 ring-1 ring-line">
        <FareLine />
      </div>

      <div id={messageId} className="min-h-5 text-sm empty:hidden">
        {state.status === "error" ? (
          <p role="alert" className="rounded-tile bg-danger-tint px-3 py-2 text-ink" data-testid="booking-error">
            Couldn't request the ride: {state.message}
          </p>
        ) : showCheck ? (
          <p className="text-danger-text">{check.message}</p>
        ) : blocked ? (
          <p className="text-muted">{blocked}</p>
        ) : !check.ok ? (
          <p className="text-muted" data-testid="booking-hint">Choose a pickup and a destination to request a ride.</p>
        ) : null}
      </div>

      <PrimaryButton type="submit" size="lg" disabled={submitting || !check.ok || blocked !== null} aria-busy={submitting}>
        {submitting ? "Requesting…" : "Request a ride"}
      </PrimaryButton>
      <p className="-mt-1 text-center text-[13px] text-muted">The route and cart are chosen by the server after you request.</p>
    </form>
  );
}
