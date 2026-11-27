import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BookingPanel, type Selection } from "./BookingPanel";
import { PricingExplainer } from "./FareInfo";
import { RideListItem } from "./RideListItem";
import { RideResultCard, useJustFinished } from "./RideResult";
import { liveStatusText } from "./LiveStatus";
import { RideStatusCard } from "./RideStatusCard";
import { MAP_NOTE, StudentMap } from "./StudentMap";
import { StillConnectingNote, useStudent } from "./studentContext";

/**
 * Student home, map first: the campus map edge to edge at the top, then a sheet directly below it with
 * the active ride (or the booking form), fares and recent rides. The same phone layout on every screen
 * size (on a computer it is the centred phone column); the sheet scrolls inside when height is short.
 */
export function HomeView() {
  const { persona, campus, realtime, rides, activeRide } = useStudent();
  // Campus Map's "Set as pickup / destination" opens Home with that stop filled in (router state only).
  const preset = (useLocation().state ?? {}) as Partial<Selection>;
  const navigate = useNavigate();
  const [selection, setSelection] = useState<Selection>({ pickupId: preset.pickupId ?? "", destinationId: preset.destinationId ?? "" });
  useEffect(() => {
    if (preset.pickupId || preset.destinationId) {
      setSelection((s) => ({ pickupId: preset.pickupId ?? s.pickupId, destinationId: preset.destinationId ?? s.destinationId }));
      navigate(".", { replace: true, state: null });
    }
  }, [preset.pickupId, preset.destinationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useJustFinished(rides);
  const recent = rides.filter((r) => !r.active).slice(0, 3);
  const loading = realtime.data === null;
  const noteId = useId();

  // After booking, the form is replaced by the ride card and the focused button disappears. Move focus to
  // the new ride's heading so keyboard and screen-reader users keep their place. Only when a ride appears
  // on a screen that was already showing the form (not on first load) and focus was lost.
  const shown = useRef<{ ready: boolean; rideId: string | null }>({ ready: false, rideId: null });
  const rideId = activeRide?.request.id ?? null;
  useEffect(() => {
    const before = shown.current;
    shown.current = { ready: !loading, rideId };
    if (!before.ready || before.rideId !== null || rideId === null) return;
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (focusLost) document.getElementById(`ride-${rideId}`)?.focus();
  }, [loading, rideId]);

  // When the followed ride ends, its card is replaced by the result card: keep focus on the new heading.
  const resultId = result.ride?.request.id ?? null;
  useEffect(() => {
    if (!resultId) return;
    const focusLost = !document.activeElement || document.activeElement === document.body;
    if (focusLost) document.getElementById(`result-${resultId}`)?.focus();
  }, [resultId]);

  return (
    <div className="flex h-[calc(100dvh-4rem-1px-env(safe-area-inset-top)-3.5rem-env(safe-area-inset-bottom))] min-h-[32rem] flex-col">
      <section id="student-map" className="shrink-0" aria-label="Campus map">
        <StudentMap ride={activeRide} pickupId={selection.pickupId} destinationId={selection.destinationId} hero noteId={noteId} />
      </section>

      {/* The sheet sits directly below the map and scrolls on its own when the screen is short. */}
      <div className="relative z-10 -mt-6 flex min-h-0 flex-1 flex-col rounded-t-sheet bg-card shadow-sheet">
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line" aria-hidden="true" />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-3" data-testid="student-sheet">
          <div className="mb-4">
            <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">Hi {persona.name}</h1>
            <p className="text-[15px] text-muted">{campus.name}</p>
            {realtime.status === "offline" && (
              <p className="mt-2 rounded-tile bg-warning-tint px-3 py-2 text-[13px] text-ink" data-testid="student-offline-note">{liveStatusText("offline")}.</p>
            )}
            <p id={noteId} className="mt-1 text-[13px] text-muted">
              {MAP_NOTE}
            </p>
          </div>

          <section className="flex flex-col gap-4" aria-label="Book or follow a ride">
            {loading ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2 rounded-card bg-surface px-4 py-5" role="status">
                  <span className="text-center text-sm text-muted">Loading your rides…</span>
                  <span className="mx-auto h-2 w-2/3 animate-pulse rounded-full bg-line" aria-hidden="true" />
                  <span className="mx-auto h-2 w-1/2 animate-pulse rounded-full bg-line" aria-hidden="true" />
                </div>
                <StillConnectingNote />
              </div>
            ) : activeRide ? (
              <RideStatusCard ride={activeRide} />
            ) : result.ride ? (
              <RideResultCard ride={result.ride} onDismiss={result.dismiss} />
            ) : (
              <BookingPanel selection={selection} onChange={setSelection} />
            )}
            <PricingExplainer />
          </section>

          <section className="mt-6" aria-labelledby="recent-title">
            <div className="mb-1 flex items-baseline justify-between">
              <h2 id="recent-title" className="text-[17px] font-bold">Recent rides</h2>
              <Link to="/student/rides" className="inline-flex min-h-11 items-center text-[14px] font-semibold text-brand-strong">
                Your rides
              </Link>
            </div>
            {loading ? null : recent.length === 0 ? (
              <p className="rounded-card bg-surface px-4 py-3 text-[14px] text-muted">No finished rides yet. Your completed and cancelled rides appear here.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card ring-1 ring-line">
                {recent.map((r) => <RideListItem key={r.request.id} ride={r} />)}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
