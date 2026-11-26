import { useMemo, useState } from "react";
import type { Persona, StateSnapshot } from "../../../shared/schemas";
import { fetchPersonas } from "../lib/api";
import { useCampus } from "../lib/campusContext";
import { createAdvanceController, createDispatchController } from "../lib/opsActions";
import { opsMetrics } from "../lib/opsMetrics";
import { useRealtime, useRealtimeStore } from "../lib/realtimeContext";
import { createOpsApi, type OpsApi } from "../lib/rideApi";
import { cartMapPoint } from "../lib/studentRides";
import { useApi } from "../lib/useApi";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { MapLegend } from "../ui/MapLegend";
import { LiveStatus } from "../student/LiveStatus";
import { DetailsPanel, DispatchPanel, FleetTable, MetricsPanel, RidesTables, SimulationPanel, type Selected } from "./OpsPanels";
import { simClock } from "./opsFormat";
import { TapPointsPanel } from "./TapPointsPanel";
import { AnalyticsPanel } from "./AnalyticsPanel";
import type { FetchAnalytics } from "../lib/analyticsApi";

/** What the map highlights for the current selection: a ride's pickup, destination, current leg and cart. */
function mapFocus(data: StateSnapshot, selected: Selected) {
  if (!selected) return { pickupId: null, destinationId: null, pathIds: [] as string[], cartId: null as string | null };
  const openTrip = (cartId: string) => data.trips.find((t) => t.cartId === cartId && (t.status === "planned" || t.status === "active" || t.status === "cancelling"));
  const trip = selected.kind === "trip" ? data.trips.find((t) => t.id === selected.id) : selected.kind === "cart" ? openTrip(selected.id) : data.trips.find((t) => t.passengers.some((p) => p.requestId === selected.id));
  const requestId = selected.kind === "request" ? selected.id : trip?.passengers[0]?.requestId;
  const request = requestId ? data.requests.find((r) => r.id === requestId) : undefined;
  return {
    pickupId: request?.pickupId ?? null,
    destinationId: request?.destinationId ?? null,
    pathIds: trip?.status === "active" && trip.leg ? trip.leg.pathIds : [],
    cartId: selected.kind === "cart" ? selected.id : trip?.cartId ?? null,
  };
}

/**
 * Operations Dashboard: fleet, requests, trips, explicit dispatch and simulation controls, details and
 * the campus map. Every figure comes from the one shared realtime store; nothing runs on its own.
 */
export function OpsDashboard({ api: injectedApi, personas: injectedPersonas, tapBaseUrl, fetchAnalytics }: { api?: OpsApi; personas?: Persona[]; /** Tests only: the Tap-In base URL (undefined = ask the server). */ tapBaseUrl?: string | null; /** Tests only: how campus analytics are loaded (undefined = GET /api/analytics). */ fetchAnalytics?: FetchAnalytics }) {
  const campus = useCampus();
  const store = useRealtimeStore();
  const realtime = useRealtime();
  const [api] = useState(() => injectedApi ?? createOpsApi());
  const loadedPersonas = useApi(fetchPersonas);
  const personas = injectedPersonas ?? (loadedPersonas.status === "ready" ? loadedPersonas.data : []);
  const deps = useMemo(() => ({ api, currentData: () => store.getState().data, resync: () => store.resync() }), [api, store]);
  const dispatch = useMemo(() => createDispatchController(deps), [deps]);
  const advance = useMemo(() => createAdvanceController(deps), [deps]);
  const [selected, setSelected] = useState<Selected>(null);

  const data = realtime.data;
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Operations Center</h1>
        <Badge emphasis="strong">Demo operator interface</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        {data && <span data-testid="header-clock">Simulation time {simClock(data.clockSeconds)} · revision {data.revision}</span>}
        <LiveStatus status={realtime.status} />
      </div>
    </div>
  );

  if (!data) {
    return (
      <>
        {header}
        <p className="rounded-tile bg-surface px-4 py-6 text-center text-sm text-muted" role="status" data-testid="ops-loading">
          {realtime.status === "offline" ? "Offline. Waiting for the server to come back…" : "Loading the live state…"}
        </p>
      </>
    );
  }

  if (data.campusId !== campus.id) {
    return (
      <>
        {header}
        <p role="alert" className="rounded-tile bg-red-50 px-4 py-3 text-sm text-ink">The server is now running a different campus. Reload the page to continue.</p>
      </>
    );
  }

  const m = opsMetrics(data);
  const focus = mapFocus(data, selected);
  const carts = data.carts.flatMap((c) => {
    const point = cartMapPoint(campus, c.position);
    return point ? [{ id: c.id, label: c.label, point, highlight: c.id === focus.cartId }] : [];
  });

  return (
    <>
      {header}
      {realtime.status !== "live" && (
        <p role="status" className="rounded-tile bg-amber-50 px-4 py-2 text-[13px] text-ink" data-testid="ops-not-live">
          {realtime.status === "offline" ? "Offline: showing the last state received. Controls still send to the server; the view updates when the connection is back." : "Syncing with the server…"}
        </p>
      )}
      <p className="text-[13px] text-muted">Demo operator interface for a fictional campus. No sign-in: anyone on this network can open it (the Ops passcode is not built yet).</p>
      <nav aria-label="Operations sections" className="flex flex-wrap gap-1.5" data-testid="ops-section-nav">
        {([["ops-overview", "Overview"], ["ops-map", "Map & details"], ["ops-dispatch", "Dispatch"], ["ops-simulation", "Simulation"], ["ops-fleet", "Fleet"], ["ops-requests", "Requests"], ["ops-trips", "Trips"], ["ops-analytics", "Analytics"], ["ops-tap-points", "Tap Points"]] as const).map(([id, label]) => (
          <a key={id} href={`#${id}`} className="inline-flex min-h-11 items-center rounded-full bg-surface px-3 text-[13px] font-semibold text-ink ring-1 ring-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{label}</a>
        ))}
      </nav>
      <MetricsPanel m={m} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-start">
        <section id="ops-map" aria-label="Campus map" className="scroll-mt-4 flex flex-col gap-2">
          <CampusMap campus={campus} overlay={{ pickupId: focus.pickupId, destinationId: focus.destinationId, routePathIds: focus.pathIds, carts }} />
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            {campus.fictional && <Badge emphasis="strong">Fictional campus</Badge>}
            <span>Schematic map, not GPS. Carts are drawn at their simulated positions from the live state.</span>
          </p>
          <div className="flex flex-col gap-1" aria-label="Map legend" role="group" data-testid="ops-map-legend">
            <MapLegend campus={campus} />
            <p className="text-[13px] text-muted">Black numbered circle: a cart at its simulated position (number from its label); an extra pink ring marks the selected cart. Rings labelled Pickup and Drop-off: the selected ride's stops.</p>
          </div>
          <DetailsPanel data={data} campus={campus} personas={personas} selected={selected} onClear={() => setSelected(null)} />
        </section>
        <section aria-label="Controls" className="flex flex-col gap-4">
          <DispatchPanel data={data} campus={campus} personas={personas} dispatch={dispatch} onSelect={setSelected} />
          <SimulationPanel data={data} advance={advance} />
        </section>
      </div>
      <FleetTable data={data} campus={campus} personas={personas} selected={selected} onSelect={setSelected} />
      <RidesTables data={data} campus={campus} personas={personas} selected={selected} onSelect={setSelected} />
      <AnalyticsPanel revision={data.revision} fetchAnalytics={fetchAnalytics} />
      <TapPointsPanel campus={campus} baseUrl={tapBaseUrl} />
    </>
  );
}
