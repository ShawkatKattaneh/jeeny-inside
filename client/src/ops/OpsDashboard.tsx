import { useEffect, useMemo, useState } from "react";
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
        <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">Operations Center</h1>
        <Badge emphasis="strong">Demo operator interface</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
        {data && <span className="tabular-nums" data-testid="header-clock">Simulation time {simClock(data.clockSeconds)} · revision {data.revision}</span>}
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
        <p role="alert" className="rounded-tile bg-danger-tint px-4 py-3 text-sm text-ink">The server is now running a different campus. Reload the page to continue.</p>
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
        <p role="status" className="rounded-tile bg-warning-tint px-4 py-2 text-[13px] text-ink" data-testid="ops-not-live">
          {realtime.status === "offline" ? "Offline: showing the last state received. Controls still send to the server; the view updates when the connection is back." : "Syncing with the server…"}
        </p>
      )}
      <p className="-mt-2 text-[13px] text-ink-2">Demo operator interface for a fictional campus. No sign-in: anyone on this network can open it (the Ops passcode is not built yet). Fleet, requests and the clock are simulated.</p>
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[11.5rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        <OpsSectionNav />
        <div className="flex min-w-0 flex-col gap-4">
          <MetricsPanel m={m} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
            <div className="flex min-w-0 flex-col gap-4">
              <section id="ops-map" aria-label="Campus map" className="scroll-mt-24 flex flex-col gap-2 rounded-card bg-card p-3 ring-1 ring-line">
                <CampusMap campus={campus} overlay={{ pickupId: focus.pickupId, destinationId: focus.destinationId, routePathIds: focus.pathIds, carts }} />
                <p className="flex flex-wrap items-center gap-2 px-1 text-[13px] text-muted">
                  {campus.fictional && <Badge emphasis="strong">Fictional campus</Badge>}
                  <span>Schematic map, not GPS. Carts are drawn at their simulated positions from the live state.</span>
                </p>
                <div className="flex flex-col gap-1 px-1" aria-label="Map legend" role="group" data-testid="ops-map-legend">
                  <MapLegend campus={campus} />
                  <p className="text-[13px] text-muted">Numbered circle (dark on the light theme, light on the dark theme): a cart at its simulated position, numbered from its label; carts at the same point are drawn side by side. An extra pink ring marks the selected cart. Rings labelled Pickup and Drop-off: the selected ride's stops.</p>
                </div>
              </section>
              <FleetTable data={data} campus={campus} personas={personas} selected={selected} onSelect={setSelected} />
            </div>
            <section aria-label="Controls" className="flex min-w-0 flex-col gap-4">
              <DispatchPanel data={data} campus={campus} personas={personas} dispatch={dispatch} onSelect={setSelected} />
              <SimulationPanel data={data} advance={advance} />
              <DetailsPanel data={data} campus={campus} personas={personas} selected={selected} onClear={() => setSelected(null)} />
            </section>
          </div>
          <RidesTables data={data} campus={campus} personas={personas} selected={selected} onSelect={setSelected} />
          <AnalyticsPanel revision={data.revision} fetchAnalytics={fetchAnalytics} />
          <TapPointsPanel campus={campus} baseUrl={tapBaseUrl} />
        </div>
      </div>
    </>
  );
}

/** The six sidebar destinations; each lists the section ids it covers (for the active state). */
const SECTIONS = [
  { label: "Live", href: "ops-overview", covers: ["ops-overview", "ops-map"] },
  { label: "Dispatch", href: "ops-dispatch", covers: ["ops-dispatch", "ops-simulation"] },
  { label: "Fleet", href: "ops-fleet", covers: ["ops-fleet"] },
  { label: "Rides", href: "ops-requests", covers: ["ops-requests", "ops-trips"] },
  { label: "Analytics", href: "ops-analytics", covers: ["ops-analytics"] },
  { label: "Tap Points", href: "ops-tap-points", covers: ["ops-tap-points"] },
] as const;

/**
 * Compact Operations sidebar (from 1024px; a scrolling chip row above it). The active item follows the
 * section in view, and is marked with aria-current and a bar, not colour alone.
 */
function OpsSectionNav() {
  const [active, setActive] = useState<string>("ops-overview");
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const ids = SECTIONS.flatMap((s) => s.covers.map((id) => ({ id, href: s.href })));
      const placed = ids
        .map((x) => ({ ...x, top: document.getElementById(x.id)?.getBoundingClientRect().top ?? Infinity }))
        .filter((x) => x.top !== Infinity)
        .sort((a, b) => a.top - b.top);
      const line = window.innerHeight * 0.3;
      let current = placed[0]?.href ?? "ops-overview";
      for (const x of placed) if (x.top <= line) current = x.href;
      // At the very bottom of the page, the last section is the one in view.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = placed[placed.length - 1]?.href ?? current;
      setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <nav
      aria-label="Operations sections"
      className="sticky top-[calc(4rem+1px+env(safe-area-inset-top))] z-20 -mx-4 overflow-x-auto bg-canvas px-4 py-2 lg:top-20 lg:mx-0 lg:self-start lg:overflow-visible lg:rounded-card lg:bg-card lg:p-2 lg:ring-1 lg:ring-line"
      data-testid="ops-section-nav"
    >
      <ul className="flex gap-1.5 lg:flex-col lg:gap-0.5">
        {SECTIONS.map((s) => {
          const on = active === s.href;
          return (
            <li key={s.href} className="shrink-0">
              <a
                href={`#${s.href}`}
                aria-current={on ? "location" : undefined}
                onClick={() => setActive(s.href)}
                className={`relative inline-flex min-h-11 w-full items-center whitespace-nowrap rounded-full px-3.5 text-[14px] transition-colors duration-150 lg:rounded-tile lg:px-3 ${
                  on
                    ? "bg-ink font-bold text-card lg:bg-brand-tint lg:text-ink lg:before:absolute lg:before:inset-y-2 lg:before:left-0 lg:before:w-[3px] lg:before:rounded-full lg:before:bg-brand lg:before:content-['']"
                    : "bg-card font-semibold text-ink-2 ring-1 ring-line hover:text-ink lg:bg-transparent lg:ring-0 lg:hover:bg-surface"
                }`}
              >
                {s.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
