import { useEffect, useId, useState, type FormEvent } from "react";
import { bookingBlockReason, checkSelection, stopLocations } from "../lib/booking";
import { LOCATION_TYPE_LABEL } from "../lib/mapGeometry";
import { PrimaryButton } from "../ui/Button";
import { Card } from "../ui/Card";
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
  const fieldClass = "h-12 w-full rounded-tile bg-surface px-3 text-sm font-semibold text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand";

  return (
    <Card className="p-4">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-describedby={messageId}>
        <h2 className="text-lg font-extrabold tracking-tight">Where to?</h2>
        <div>
          <label htmlFor={pickupFieldId} className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-muted">
            <span className="inline-block h-2.5 w-2.5 rounded-full ring-[3px] ring-brand" aria-hidden="true" /> Pickup
          </label>
          <select
            id={pickupFieldId}
            className={fieldClass}
            value={selection.pickupId}
            disabled={submitting}
            aria-invalid={showCheck && !check.ok && check.field === "pickupId" ? true : undefined}
            onChange={(e) => onChange({ ...selection, pickupId: e.target.value })}
          >
            <option value="">Choose pickup</option>
            {options}
          </select>
        </div>
        <div className="flex justify-center">
          <button
            type="button"
            className="min-h-11 rounded-full px-4 py-1 text-[13px] font-semibold text-muted ring-1 ring-line disabled:opacity-40"
            disabled={submitting || (!selection.pickupId && !selection.destinationId)}
            onClick={() => onChange({ pickupId: selection.destinationId, destinationId: selection.pickupId })}
          >
            Swap pickup and destination
          </button>
        </div>
        <div>
          <label htmlFor={destFieldId} className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-muted">
            <span className="inline-block h-2.5 w-2.5 rounded-full ring-[3px] ring-dropoff" aria-hidden="true" /> Destination
          </label>
          <select
            id={destFieldId}
            className={fieldClass}
            value={selection.destinationId}
            disabled={submitting}
            aria-invalid={showCheck && !check.ok && check.field === "destinationId" ? true : undefined}
            onChange={(e) => onChange({ ...selection, destinationId: e.target.value })}
          >
            <option value="">Choose destination</option>
            {options}
          </select>
        </div>

        <fieldset className="flex flex-col gap-1.5" aria-describedby={modeHelpId}>
          <legend className="mb-1 text-[13px] font-semibold text-muted">Ride type</legend>
          <div className="grid grid-cols-2 gap-2" data-testid="mode-choice">
            {(["solo", "shared"] as const).map((m) => (
              <label
                key={m}
                className={`flex h-11 cursor-pointer items-center justify-center gap-2 rounded-tile text-sm font-semibold ring-1 ${mode === m ? "bg-brand-tint text-ink ring-brand" : "bg-surface text-ink ring-line"}`}
              >
                <input type="radio" name="ride-mode" value={m} checked={mode === m} disabled={submitting} onChange={() => setMode(m)} className="accent-[var(--color-brand)]" />
                {m === "solo" ? "Solo" : "Shared"}
              </label>
            ))}
          </div>
          <p id={modeHelpId} className="text-[13px] text-muted" data-testid="mode-help">
            {mode === "shared"
              ? "Shared may combine your ride with compatible rides on the same cart. A match is not guaranteed: it depends on the live carts and trips when your ride is dispatched. Same fare."
              : "Solo: a cart for your ride only."}
          </p>
        </fieldset>

        <FareLine />

        <div id={messageId} className="min-h-5 text-sm">
          {state.status === "error" ? (
            <p role="alert" className="rounded-tile bg-red-50 px-3 py-2 text-ink" data-testid="booking-error">
              Couldn't request the ride: {state.message}
            </p>
          ) : showCheck ? (
            <p className="text-danger">{check.message}</p>
          ) : blocked ? (
            <p className="text-muted">{blocked}</p>
          ) : !check.ok ? (
            <p className="text-muted" data-testid="booking-hint">Choose a pickup and a destination to request a ride.</p>
          ) : null}
        </div>

        <PrimaryButton type="submit" disabled={submitting || !check.ok || blocked !== null} aria-busy={submitting}>
          {submitting ? "Requesting…" : "Request a ride"}
        </PrimaryButton>
        <p className="text-center text-[13px] text-muted">The route and cart are chosen by the server after you request.</p>
      </form>
    </Card>
  );
}
