import { stopLocations } from "../lib/booking";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { simClock } from "../ops/opsFormat";
import { StudentPage } from "./StudentPage";
import { StillConnectingNote, useStudent } from "./studentContext";

const WAITING = ["requested", "assigned", "arriving"] as const;

/**
 * Campus Pulse: what is happening on campus right now, counted from the live state the server sends (the
 * same snapshot every screen uses). Counts only; no wait times or forecasts, which no API provides.
 */
export function PulseView() {
  const { campus, realtime } = useStudent();
  const data = realtime.data;
  return (
    <StudentPage id="pulse-title" title="Campus Pulse" back={{ to: "/student/quick", label: "Quick actions" }} intro={<>Live from the demo server for {campus.name}. <Badge tone="simulated">Simulated fleet</Badge></>}>
      {!data ? (
        <div className="flex flex-col gap-2">
          <p className="rounded-card bg-surface px-4 py-6 text-center text-sm text-muted" role="status">Loading live campus activity…</p>
          <StillConnectingNote />
        </div>
      ) : (
        <PulseBody data={data} stops={stopLocations(campus)} />
      )}
    </StudentPage>
  );
}

function PulseBody({ data, stops }: { data: NonNullable<ReturnType<typeof useStudent>["realtime"]["data"]>; stops: ReturnType<typeof stopLocations> }) {
  const carts = data.carts;
  const idle = carts.filter((c) => c.status === "idle").length;
  const busy = carts.filter((c) => c.status === "assigned" || c.status === "occupied").length;
  const out = carts.length - idle - busy;
  const awaiting = data.requests.filter((r) => r.status === "requested").length;
  const openTrips = data.trips.filter((t) => t.status === "planned" || t.status === "active" || t.status === "cancelling").length;
  const waitingAt = (id: string) => data.requests.filter((r) => r.pickupId === id && (WAITING as readonly string[]).includes(r.status)).length;
  const pickupStops = stops.filter((s) => s.type === "pickup" || waitingAt(s.id) > 0);
  const tile = (label: string, value: number, hint: string, testId: string) => (
    <div className="rounded-tile bg-surface px-3 py-2.5">
      <div className="text-[13px] text-muted">{label}</div>
      <div className="text-[26px] font-extrabold leading-tight tabular-nums" data-testid={testId}>{value}</div>
      <div className="text-[13px] text-muted">{hint}</div>
    </div>
  );
  return (
    <>
      <Card className="flex flex-col gap-3 p-4" role="region" aria-labelledby="pulse-fleet">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="pulse-fleet" className="text-[17px] font-bold">Carts and requests now</h2>
          <span className="text-[13px] text-muted tabular-nums">Simulation time {simClock(data.clockSeconds)}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {tile("Idle carts", idle, `of ${carts.length} in the fleet`, "pulse-idle")}
          {tile("Carts on trips", busy, out ? `${out} out of service` : "assigned or carrying riders", "pulse-busy")}
          {tile("Waiting for dispatch", awaiting, "ride requests not yet assigned", "pulse-awaiting")}
          {tile("Open trips", openTrips, "planned or under way", "pulse-trips")}
        </div>
        <p className="text-[13px] text-muted">Average wait and arrival times: not available (the server does not report them).</p>
      </Card>
      <Card className="overflow-hidden" role="region" aria-labelledby="pulse-stops">
        <h2 id="pulse-stops" className="border-b border-line px-4 py-3 text-[17px] font-bold">Pickup points</h2>
        <ul className="divide-y divide-line">
          {pickupStops.map((s) => {
            const n = waitingAt(s.id);
            return (
              <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold">{s.name}</span>
                  <span className="block text-[13px] text-muted">{s.type === "pickup" ? "Pickup point · NFC Tap-In and QR" : "Campus stop"}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${n ? "bg-brand-tint text-ink" : "bg-surface text-muted"}`} data-testid={`pulse-stop-${s.id}`}>
                  {n === 0 ? "No riders waiting" : `${n} rider${n === 1 ? "" : "s"} waiting`}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
