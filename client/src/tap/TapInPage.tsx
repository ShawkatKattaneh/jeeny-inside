import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { Location, Persona } from "../../../shared/schemas";
import { fetchPersonas } from "../lib/api";
import { useCampus } from "../lib/campusContext";
import { loadPersona, savePersona } from "../lib/persona";
import { RealtimeProvider } from "../lib/realtimeContext";
import type { RealtimeStore } from "../lib/realtimeStore";
import type { RideApi } from "../lib/rideApi";
import { PHASE_LABEL } from "../lib/studentRides";
import {
  TAP_IN_ERROR_TEXT, arrivalState, createTapInApi, createTapInSubmitter, passengerOf, resolveTapPoint, sendable, tapCandidates,
  type TapCandidate, type TapInApi, type TapInResponse,
} from "../lib/tapIn";
import { useApi } from "../lib/useApi";
import { formatSimTime, locationName } from "../student/format";
import { StillConnectingNote, StudentProvider, useStudent } from "../student/studentContext";
import { BrandLockup } from "../ui/Brand";
import { PrimaryButton } from "../ui/Button";
import { Card } from "../ui/Card";

/** Shown with every Tap-In result: what a Tap-In is not. */
export const TAP_IN_LIMITS = "This records your check-in. It doesn't verify your location or identity, and it doesn't board you.";

/**
 * Phase 4 Tap-In: /tap/:campusId/:locationId. NFC tags and printed QR codes open this same URL in the
 * phone's browser (the phone's own NFC reader or camera; no Web NFC, no in-app scanner). The screen
 * names the point, finds the student's ride from the live state, and records a Tap-In only after the
 * student confirms and the server answers 200. It never boards anyone: the driver does that.
 * It sits outside the Student area so a missing persona does not lose the scanned point.
 * `store`, `api`, `tapApi` and `personas` are for tests.
 */
export function TapInPage({ store, api, tapApi, personas }: { store?: RealtimeStore; api?: RideApi; tapApi?: TapInApi; personas?: Persona[] } = {}) {
  const { campusId = "", locationId = "" } = useParams();
  const campus = useCampus();
  const point = resolveTapPoint(campus, campusId, locationId);
  const [persona, setPersona] = useState<Persona | null>(() => loadPersona());

  let body: ReactNode;
  if (point.kind !== "ok") {
    body = <PointProblem point={point} campusName={campus.name} />;
  } else if (!persona || persona.role !== "student") {
    body = (
      <ChooseStudent
        point={point.location}
        current={persona}
        injected={personas}
        onChoose={(p) => {
          savePersona(p);
          setPersona(p);
        }}
      />
    );
  } else {
    body = (
      <RealtimeProvider store={store}>
        <StudentProvider persona={persona} campus={campus} api={api}>
          <TapInScreen point={point.location} tapApi={tapApi} />
        </StudentProvider>
      </RealtimeProvider>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
      <header className="flex items-center gap-3 py-2">
        <BrandLockup size={28} />
        <span className="ml-auto truncate text-right text-[13px] text-muted">
          {persona?.role === "student" ? <span className="block font-semibold text-ink">{persona.name}</span> : null}
          Tap-In
        </span>
      </header>
      <section className="flex flex-col gap-1" aria-label="Tap point">
        <div className="text-[13px] text-muted">Pickup point · {campus.name}</div>
        <h1 className="text-2xl font-extrabold tracking-tight" data-testid="tap-point">
          {point.kind === "ok" || point.kind === "not_supported" ? point.location.name : "Unknown tap point"}
        </h1>
      </section>
      {body}
    </div>
  );
}

function PointProblem({ point, campusName }: { point: Exclude<ReturnType<typeof resolveTapPoint>, { kind: "ok" }>; campusName: string }) {
  const text =
    point.kind === "wrong_campus"
      ? `This tag or QR code is for another campus, not ${campusName}. Nothing was recorded.`
      : point.kind === "unknown"
        ? `This tag or QR code names a point ${campusName} doesn't have. Nothing was recorded.`
        : `${point.location.name} isn't a pickup point, so you can't tap in here. Nothing was recorded.`;
  return (
    <>
      <p role="alert" className="rounded-tile bg-red-50 px-4 py-3 text-sm text-ink" data-testid="tap-point-problem">{text}</p>
      <Link to="/student" className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-brand">Go to the Student app</Link>
    </>
  );
}

/** A tap opened on a phone with no student persona: pick one, and stay on this tap point. */
function ChooseStudent({ point, current, injected, onChoose }: { point: Location; current: Persona | null; injected?: Persona[]; onChoose: (p: Persona) => void }) {
  const loaded = useApi(injected ? () => Promise.resolve(injected) : fetchPersonas);
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="tap-choose-student">
      <h2 className="text-base font-bold">Who is tapping in?</h2>
      <p className="text-sm text-muted">
        {current ? `Tap-In is for students, and this phone is set to ${current.name}.` : "This phone has no demo persona yet."} Choose your student persona to continue at {point.name}.
        No login: the choice is remembered on this phone.
      </p>
      {loaded.status === "loading" && <p className="text-sm text-muted">Loading personas…</p>}
      {loaded.status === "error" && <p role="alert" className="text-sm text-danger">Could not load personas: {loaded.message}</p>}
      {loaded.status === "ready" && (
        <ul className="flex flex-col gap-2">
          {loaded.data.filter((p) => p.role === "student").map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onChoose(p)} className="flex w-full items-center gap-3 rounded-tile bg-surface px-4 py-3 text-left">
                <span className="font-bold">{p.name}</span>
                <span className="text-[13px] text-muted">{p.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TapInScreen({ point, tapApi }: { point: Location; tapApi?: TapInApi }) {
  const { persona, campus, realtime, rides, store } = useStudent();
  const [submitter] = useState(() =>
    createTapInSubmitter(tapApi ?? createTapInApi(), (result) => {
      // The socket update normally arrives first; if the live state lacks the record, ask for a fresh snapshot.
      const live = store.getState().data?.trips.find((t) => t.id === result.trip.id);
      if (!live?.passengers.some((p) => p.requestId === result.request.id && p.tappedIn)) store.resync();
    }),
  );
  const submit = useSyncExternalStore(submitter.subscribe, submitter.getState, submitter.getState);
  const [chosen, setChosen] = useState<string | null>(null);

  if (realtime.data === null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="rounded-tile bg-surface px-4 py-6 text-center text-sm text-muted" role="status">Loading your rides…</p>
        <StillConnectingNote />
      </div>
    );
  }

  const candidates = tapCandidates(rides, point.id);
  const options = candidates.filter(sendable);
  // Exactly one sendable ride is identified; with several, the student must choose (never guessed).
  const selectedId = options.length === 1 ? options[0]!.ride.request.id : options.some((c) => c.ride.request.id === chosen) ? chosen : null;

  function confirm() {
    if (!selectedId) return;
    // Every check is repeated by the server against the current state; this screen's list is only a hint.
    void submitter.submit(selectedId, { studentId: persona.id, campusId: campus.id, pointId: point.id });
  }

  if (submit.step === "done") return <TapInResult result={submit.result} point={point} />;

  if (candidates.length === 0) {
    const pending = rides.find((r) => r.active && r.request.status === "requested");
    return (
      <Card className="flex flex-col gap-2 p-4" data-testid="tap-no-ride">
        <h2 className="text-base font-bold">No ride to tap in for here</h2>
        <p className="text-sm text-muted">
          {pending
            ? `Your ride ${pending.request.id} doesn't have a cart yet. You can tap in once a cart is assigned.`
            : "You don't have a ride with a cart assigned. Book a ride first, then tap in at its pickup point."}
        </p>
        <Link to="/student" className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-brand">Go to the Student app</Link>
      </Card>
    );
  }

  return (
    <>
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-base font-bold">{options.length > 1 ? "Choose the ride you're tapping in for" : "Your ride"}</h2>
        <ul className="flex flex-col gap-2" data-testid="tap-candidates">
          {candidates.map((c) => (
            <CandidateRow
              key={c.ride.request.id}
              c={c}
              pointName={point.name}
              pickable={sendable(c) && options.length > 1}
              checked={selectedId === c.ride.request.id}
              onPick={() => setChosen(c.ride.request.id)}
              campusLocation={(id) => locationName(campus, id)}
            />
          ))}
        </ul>
        {options.length === 0 && (
          <p className="text-sm text-muted" data-testid="tap-nothing-sendable">None of your rides picks you up at {point.name}, so there is nothing to tap in for here.</p>
        )}
      </Card>

      {submit.step === "error" && (
        <p role="alert" className="rounded-tile bg-red-50 px-4 py-3 text-sm text-ink" data-testid="tap-error">
          <b>{TAP_IN_ERROR_TEXT[submit.code] ?? "Tap-In wasn't recorded."}</b> {submit.message}
          <span className="mt-1 block text-[13px]">Nothing was recorded.</span>
        </p>
      )}

      {options.length > 0 && (
        <div className="flex flex-col gap-2">
          <PrimaryButton type="button" onClick={confirm} disabled={!selectedId || submit.step === "sending"} aria-busy={submit.step === "sending"} data-testid="tap-confirm">
            {submit.step === "sending" ? "Sending…" : `Confirm Tap-In at ${point.name}`}
          </PrimaryButton>
          {!selectedId && <p className="text-center text-[13px] text-muted" data-testid="tap-choose-first">Choose a ride above first.</p>}
          {submit.step === "sending" && <p className="text-center text-[13px] text-muted" role="status">Waiting for the server to confirm…</p>}
          <p className="text-[13px] text-muted">{TAP_IN_LIMITS}</p>
        </div>
      )}
    </>
  );
}

function CandidateRow({ c, pointName, pickable, checked, onPick, campusLocation }: {
  c: TapCandidate;
  pointName: string;
  pickable: boolean;
  checked: boolean;
  onPick: () => void;
  campusLocation: (id: string) => string;
}) {
  const r = c.ride.request;
  const rec = passengerOf(c.ride.trip, r.id)?.tappedIn;
  const arrival = arrivalState(r, passengerOf(c.ride.trip, r.id));
  let note: string;
  if (c.kind === "ready") note = "Not tapped in yet.";
  else if (c.kind === "recorded_here") {
    note = `Already tapped in here at ${formatSimTime(rec!.atMs)}.`;
    if (arrival?.kind === "history") note += r.status === "cancelled" ? " This ride is cancelled: the Tap-In is history only." : r.status === "on_board" ? " You're already on board: the Tap-In is history." : r.status === "completed" ? " This ride is finished: the Tap-In is history." : " It is not your current pickup.";
  } else if (rec) note = `Already tapped in at ${campusLocation(rec.locationId)}, not ${pointName}.`;
  else note = `Your pickup for this ride is ${campusLocation(r.pickupId)}, not ${pointName}. Tap in there instead.`;

  const content = (
    <span className="flex min-w-0 flex-col">
      <span className="font-semibold">{r.id} · {campusLocation(r.pickupId)} → {campusLocation(r.destinationId)}</span>
      <span className={`text-[13px] ${checked ? "text-ink" : "text-muted"}`}>Ride status: {PHASE_LABEL[c.ride.phase]}</span>
      <span className={`text-[13px] ${c.kind === "other_pickup" ? "text-danger" : "text-ink"}`} data-testid={`tap-note-${r.id}`}>{note}</span>
    </span>
  );
  return (
    <li className={`rounded-tile px-3 py-2 text-sm ring-1 ${checked ? "bg-brand-tint ring-brand" : "ring-line"}`} data-testid={`tap-candidate-${r.id}`} data-kind={c.kind}>
      {pickable ? (
        <label className="flex cursor-pointer items-start gap-2">
          <input type="radio" name="tap-ride" value={r.id} checked={checked} onChange={onPick} className="mt-1" />
          {content}
        </label>
      ) : (
        content
      )}
    </li>
  );
}

export function TapInResult({ result, point }: { result: TapInResponse; point: Location }) {
  const { request, tapIn, alreadyRecorded } = result;
  const p = result.trip.passengers.find((x) => x.requestId === request.id) ?? null;
  const arrival = arrivalState(request, p);
  const historyNote =
    arrival?.kind === "history"
      ? request.status === "cancelled"
        ? "This ride is cancelled. The Tap-In is kept as history only; it is not a current arrival."
        : request.status === "on_board"
          ? "You're already on board (the driver confirmed boarding). The Tap-In is kept as history."
          : request.status === "completed"
            ? "This ride is finished. The Tap-In is kept as history."
            : "This Tap-In is not at your current pickup."
      : null;
  return (
    <Card className="flex flex-col gap-2 p-4" role="status" data-testid="tap-result" data-already={alreadyRecorded ? "yes" : "no"}>
      <h2 className="text-base font-bold text-ink" data-testid="tap-result-title">
        {alreadyRecorded ? `Already tapped in here at ${formatSimTime(tapIn.atMs)}.` : `Tap-In recorded at ${point.name}.`}
      </h2>
      {arrival?.kind === "current" && <p className="text-sm">Wait here: your driver confirms boarding.</p>}
      {historyNote && <p className="rounded-tile bg-surface px-3 py-2 text-sm" data-testid="tap-history-note">{historyNote}</p>}
      <p className="text-[13px] text-muted">Ride {request.id} · recorded at {formatSimTime(tapIn.atMs)} (simulation time)</p>
      <p className="text-[13px] text-muted">{TAP_IN_LIMITS}</p>
      <Link to={`/student/rides/${encodeURIComponent(request.id)}`} className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-brand">See your ride</Link>
    </Card>
  );
}
