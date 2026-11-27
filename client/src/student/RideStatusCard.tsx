import { useRef, useState } from "react";
import { useFlashOnChange } from "../ui/useFlashOnChange";
import { Link } from "react-router-dom";
import { PHASE_LABEL, TRACK_STEPS, canCancel, phaseDetail, sharedCancelNote, sharedRideLines, trackStepIndex, type RidePhase, type StudentRide } from "../lib/studentRides";
import { Badge } from "../ui/Badge";
import { BusyLabel } from "../ui/Button";
import { Card } from "../ui/Card";
import { arrivalState, passengerOf, showTapInEntry, tapPath } from "../lib/tapIn";
import { FareLine } from "./FareInfo";
import { formatSimTime, locationName } from "./format";
import { useStudent } from "./studentContext";

const PHASE_TONE: Record<RidePhase, string> = {
  requested: "bg-surface text-ink",
  assigned: "bg-brand-tint text-ink",
  approaching: "bg-brand-tint text-ink",
  at_pickup: "bg-brand text-white",
  in_progress: "bg-brand-tint text-ink",
  at_destination: "bg-brand-tint text-ink",
  completed: "bg-success-tint text-ink",
  cancelled: "bg-surface text-muted",
};

const TRIP_TEXT: Record<NonNullable<StudentRide["trip"]>["status"], string> = {
  planned: "Planned, not started",
  active: "Under way",
  cancelling: "Ending",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function PhasePill({ phase }: { phase: RidePhase }) {
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[13px] font-bold ${PHASE_TONE[phase]}`}>{PHASE_LABEL[phase]}</span>;
}

/** Step tracker. Steps are marked done only up to the phase the server reports. */
function Tracker({ phase }: { phase: RidePhase }) {
  if (phase === "cancelled") return null;
  const current = trackStepIndex(phase);
  return (
    <ol className="grid grid-cols-3 gap-x-1.5 gap-y-2.5" aria-label="Ride progress">
      {TRACK_STEPS.map((s, i) => (
        <li key={s.phase} className="flex flex-col items-center gap-1 text-center" aria-current={i === current ? "step" : undefined}>
          <span className={`h-1.5 w-full rounded-full ${i <= current ? "bg-brand" : "bg-line"}`} aria-hidden="true" />
          <span className={`text-[13px] leading-tight ${i === current ? "font-bold text-ink" : "text-muted"}`}>
            {s.label}
            <span className="sr-only">{i < current ? " (done)" : i === current ? " (current)" : " (not yet)"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The status of one ride, from the live state. Cancelling goes through the API and the card waits for
 * the server's update to show the new status; nothing is changed locally.
 */
export function RideStatusCard({ ride, showDetailsLink = true }: { ride: StudentRide; showDetailsLink?: boolean }) {
  const { campus, api, store } = useStudent();
  const [cancel, setCancel] = useState<{ step: "idle" | "confirm" | "sending" } | { step: "error"; message: string }>({ step: "idle" });

  const sending = useRef(false); // guards against a second tap before React re-renders
  const flash = useFlashOnChange(ride.phase);
  const sharedLines = sharedRideLines(ride);
  const cancelNote = sharedCancelNote(ride);

  async function confirmCancel() {
    if (sending.current) return;
    sending.current = true;
    setCancel({ step: "sending" });
    const res = await api.cancelRide(ride.request.id).finally(() => {
      sending.current = false;
    });
    if (!res.ok) return setCancel({ step: "error", message: res.message });
    setCancel({ step: "idle" });
    // The socket update normally arrives first; if it has not, ask for a fresh snapshot.
    const live = store.getState().data?.requests.find((r) => r.id === ride.request.id);
    if (!live || live.status !== res.value.status) store.resync();
  }

  return (
    <Card className="flex flex-col gap-3 p-4" aria-labelledby={`ride-${ride.request.id}`} role="region">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] text-muted">
            {ride.active ? "Your ride" : "Ride"} · {ride.request.id}
            {ride.request.mode === "shared" && <> · <span className="font-bold text-brand-strong" data-testid="ride-shared">Shared</span></>}
          </div>
          <h2 id={`ride-${ride.request.id}`} tabIndex={-1} className={`-mx-1 scroll-mt-12 px-1 text-2xl font-extrabold tracking-tight ${flash}`} data-testid="ride-phase">
            {PHASE_LABEL[ride.phase]}
          </h2>
        </div>
        {ride.cart && (
          <div className="text-right">
            <div className="text-sm font-bold" data-testid="ride-cart">{ride.cart.label}</div>
            {ride.cart.simulated && <Badge tone="simulated" emphasis="strong">Simulated</Badge>}
          </div>
        )}
      </div>
      <p className="text-sm text-ink" role="status" aria-live="polite">
        {phaseDetail(ride, campus)}
        {!ride.synced && <span className="mt-1 block text-[13px] text-muted">Confirming with live updates…</span>}
      </p>
      {sharedLines.length > 0 && (
        <ul className="flex flex-col gap-0.5 rounded-tile bg-brand-tint px-3 py-2 text-[13px] text-ink" data-testid="shared-info">
          {sharedLines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      <Tracker phase={ride.phase} />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">From</dt>
        <dd className="truncate font-semibold">{locationName(campus, ride.request.pickupId)}</dd>
        <dt className="text-muted">To</dt>
        <dd className="truncate font-semibold">{locationName(campus, ride.request.destinationId)}</dd>
        {ride.request.mode === "shared" && ride.trip && (
          <>
            <dt className="text-muted">Trip</dt>
            <dd className="break-words" data-testid="shared-trip-status">{TRIP_TEXT[ride.trip.status]} <span className="text-[13px] text-muted">(the whole cart's trip, not just your ride)</span></dd>
          </>
        )}
      </dl>
      <FareLine request={ride.request} />
      <TapInLine ride={ride} />

      {cancel.step === "error" && (
        <p role="alert" className="rounded-tile bg-danger-tint px-3 py-2 text-sm text-ink">
          Couldn't cancel: {cancel.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {showDetailsLink && (
          <Link to={`/student/rides/${encodeURIComponent(ride.request.id)}`} className="inline-flex min-h-11 items-center rounded-full bg-card px-4 py-2 text-sm font-semibold text-ink ring-1 ring-line hover:bg-surface">
            Ride details
          </Link>
        )}
        {showTapInEntry(ride) && (
          <Link to={tapPath(campus.id, ride.request.pickupId)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-info-tint px-4 py-2 text-sm font-semibold text-ink ring-1 ring-info/30" data-testid="tap-entry">
            I'm at my pickup
          </Link>
        )}
        {canCancel(ride) && cancel.step !== "confirm" && cancel.step !== "sending" && (
          <button type="button" onClick={() => setCancel({ step: "confirm" })} className="inline-flex min-h-11 items-center rounded-full px-4 py-2 text-sm font-semibold text-danger-text ring-1 ring-line">
            Cancel ride
          </button>
        )}
        {(cancel.step === "confirm" || cancel.step === "sending") && (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span>Cancel this ride?</span>
            {cancelNote && <span className="basis-full text-[13px] text-muted" data-testid="shared-cancel-note">{cancelNote}</span>}
            <button
              type="button"
              onClick={confirmCancel}
              disabled={cancel.step === "sending"}
              aria-busy={cancel.step === "sending"}
              className={`inline-flex min-h-11 items-center rounded-full px-4 py-2 font-semibold ${cancel.step === "sending" ? "cursor-progress bg-danger text-white" : "bg-danger text-white"}`}
            >
              {cancel.step === "sending" ? <BusyLabel>Cancelling…</BusyLabel> : "Yes, cancel"}
            </button>
            <button type="button" onClick={() => setCancel({ step: "idle" })} disabled={cancel.step === "sending"} className="inline-flex min-h-11 items-center rounded-full px-4 py-2 font-semibold ring-1 ring-line">
              Keep ride
            </button>
          </span>
        )}
      </div>
    </Card>
  );
}

/**
 * Phase 4 Tap-In on the ride card. A current arrival only when the record is at the CURRENT pickup and the
 * rider is still waiting; otherwise the record is shown as history. Never says "boarded" or "verified".
 */
function TapInLine({ ride }: { ride: StudentRide }) {
  const { campus } = useStudent();
  const a = arrivalState(ride.request, passengerOf(ride.trip, ride.request.id));
  if (!a) return null;
  const where = locationName(campus, a.locationId);
  if (a.kind === "current") {
    return (
      <p className="flex items-baseline gap-2 rounded-tile bg-info-tint px-3 py-2 text-[13px] text-ink before:inline-block before:h-0 before:w-0 before:shrink-0 before:border-x-[5px] before:border-b-[9px] before:border-x-transparent before:border-b-info before:content-['']" data-testid="ride-tapin" data-arrival="current">
        Tapped in at {where} · {formatSimTime(a.atMs)}. Wait here: your driver confirms boarding.
      </p>
    );
  }
  const why = !a.atCurrentPickup ? "not your current pickup" : ride.request.status === "cancelled" ? "this ride is cancelled" : "history only";
  return (
    <p className="rounded-tile bg-surface px-3 py-2 text-[13px] text-muted" data-testid="ride-tapin" data-arrival="history">
      Earlier Tap-In at {where} · {formatSimTime(a.atMs)} ({why})
    </p>
  );
}
