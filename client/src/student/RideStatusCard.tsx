import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PHASE_LABEL, TRACK_STEPS, canCancel, phaseDetail, trackStepIndex, type RidePhase, type StudentRide } from "../lib/studentRides";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { FareLine } from "./FareInfo";
import { locationName } from "./format";
import { useStudent } from "./studentContext";

const PHASE_TONE: Record<RidePhase, string> = {
  requested: "bg-surface text-ink",
  assigned: "bg-brand-tint text-brand",
  approaching: "bg-brand-tint text-brand",
  at_pickup: "bg-brand text-white",
  in_progress: "bg-brand-tint text-brand",
  at_destination: "bg-brand-tint text-brand",
  completed: "bg-green-50 text-success",
  cancelled: "bg-surface text-muted",
};

export function PhasePill({ phase }: { phase: RidePhase }) {
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold ${PHASE_TONE[phase]}`}>{PHASE_LABEL[phase]}</span>;
}

/** Step tracker. Steps are marked done only up to the phase the server reports. */
function Tracker({ phase }: { phase: RidePhase }) {
  if (phase === "cancelled") return null;
  const current = trackStepIndex(phase);
  return (
    <ol className="grid grid-cols-6 gap-1" aria-label="Ride progress">
      {TRACK_STEPS.map((s, i) => (
        <li key={s.phase} className="flex flex-col items-center gap-1 text-center" aria-current={i === current ? "step" : undefined}>
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
 * The status of one ride, from the live state. Cancelling goes through the API and the card waits for
 * the server's update to show the new status; nothing is changed locally.
 */
export function RideStatusCard({ ride, showDetailsLink = true }: { ride: StudentRide; showDetailsLink?: boolean }) {
  const { campus, api, store } = useStudent();
  const [cancel, setCancel] = useState<{ step: "idle" | "confirm" | "sending" } | { step: "error"; message: string }>({ step: "idle" });

  const sending = useRef(false); // guards against a second tap before React re-renders

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
          <div className="text-xs text-muted">{ride.active ? "Your ride" : "Ride"} · {ride.request.id}</div>
          <h2 id={`ride-${ride.request.id}`} className="text-lg font-extrabold tracking-tight" data-testid="ride-phase">
            {PHASE_LABEL[ride.phase]}
          </h2>
        </div>
        {ride.cart && (
          <div className="text-right">
            <div className="text-sm font-bold" data-testid="ride-cart">{ride.cart.label}</div>
            {ride.cart.simulated && <Badge tone="simulated">Simulated</Badge>}
          </div>
        )}
      </div>
      <p className="text-sm text-ink" role="status" aria-live="polite">
        {phaseDetail(ride, campus)}
        {!ride.synced && <span className="mt-1 block text-xs text-muted">Confirming with live updates…</span>}
      </p>
      <Tracker phase={ride.phase} />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">From</dt>
        <dd className="truncate font-semibold">{locationName(campus, ride.request.pickupId)}</dd>
        <dt className="text-muted">To</dt>
        <dd className="truncate font-semibold">{locationName(campus, ride.request.destinationId)}</dd>
      </dl>
      <FareLine request={ride.request} />

      {cancel.step === "error" && (
        <p role="alert" className="rounded-tile bg-red-50 px-3 py-2 text-sm text-danger">
          Couldn't cancel: {cancel.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {showDetailsLink && (
          <Link to={`/student/rides/${encodeURIComponent(ride.request.id)}`} className="rounded-full bg-surface px-4 py-2 text-sm font-semibold text-ink">
            Ride details
          </Link>
        )}
        {canCancel(ride) && cancel.step !== "confirm" && cancel.step !== "sending" && (
          <button type="button" onClick={() => setCancel({ step: "confirm" })} className="rounded-full px-4 py-2 text-sm font-semibold text-danger ring-1 ring-line">
            Cancel ride
          </button>
        )}
        {(cancel.step === "confirm" || cancel.step === "sending") && (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span>Cancel this ride?</span>
            <button
              type="button"
              onClick={confirmCancel}
              disabled={cancel.step === "sending"}
              className="rounded-full bg-danger px-4 py-2 font-semibold text-white disabled:opacity-50"
            >
              {cancel.step === "sending" ? "Cancelling…" : "Yes, cancel"}
            </button>
            <button type="button" onClick={() => setCancel({ step: "idle" })} disabled={cancel.step === "sending"} className="rounded-full px-4 py-2 font-semibold ring-1 ring-line">
              Keep ride
            </button>
          </span>
        )}
      </div>
    </Card>
  );
}
