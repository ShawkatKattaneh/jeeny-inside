import type { CampusConfig, Location, Point } from "../../../shared/schemas";
import { labelSize, oneWayArrow, pathSegments } from "../lib/mapGeometry";

export interface CampusMapOverlay {
  /** Selected or booked pickup and destination, highlighted on the map. */
  pickupId?: string | null;
  destinationId?: string | null;
  /** Path ids of a route the server planned (a trip's current leg). Never computed by the client. */
  routePathIds?: readonly string[];
  /** A cart to draw at the position the server reports (map units, not GPS). */
  cart?: { label: string; point: Point } | null;
  /** Several carts (Operations Dashboard), each at its server-reported position; `highlight` rings one. */
  carts?: readonly { id: string; label: string; point: Point; highlight?: boolean }[];
}

/**
 * The campus map, drawn entirely from the campus config file (D3).
 * Desaturated light-gray base, thin paths, the plan's marker grammar.
 * The optional overlay (Student App, Phase 3) highlights a pickup, a destination, a route the server
 * planned and one cart at its server-reported position. Without it the map is unchanged.
 */
export function CampusMap({ campus, className = "", overlay, flush = false }: { campus: CampusConfig; className?: string; overlay?: CampusMapOverlay; flush?: boolean }) {
  const { width, height } = campus.map;
  const fs = labelSize(campus);
  const segments = pathSegments(campus);
  const route = new Set(overlay?.routePathIds ?? []);
  const posOf = (id: string | null | undefined) => (id ? campus.locations.find((l) => l.id === id)?.position ?? null : null);
  const pickup = posOf(overlay?.pickupId);
  const destination = posOf(overlay?.destinationId);
  // Label placement only (positions are unchanged): a location with a stop ring or a cart on it gets its
  // name drawn below the ring, so the name never sits under the ring or the cart marker.
  const ringed = new Set([overlay?.pickupId, overlay?.destinationId].filter((x): x is string => !!x));
  const cartPoints = [...(overlay?.carts ?? []).map((c) => c.point), ...(overlay?.cart ? [overlay.cart.point] : [])];
  // Carts reported at the very same point are drawn side by side (a small display offset) so each stays
  // visible; their reported position is still the point they share (see each marker's title).
  const fanned = (overlay?.carts ?? []).map((c, _i, all) => {
    const group = all.filter((o) => near(o.point, c.point));
    const k = group.indexOf(c);
    const dx = group.length > 1 ? (k - (group.length - 1) / 2) * fs * 2.1 : 0;
    return { c, x: c.point.x + dx, y: c.point.y };
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`block w-full bg-map-bg ${flush ? "h-full" : "h-auto rounded-tile"} ${className}`}
      role="img"
      aria-label={`Map of ${campus.name}`}
    >
      {/* Building and parking footprints */}
      {campus.locations
        .filter((l) => l.footprint)
        .map((l) => (
          <rect
            key={`fp-${l.id}`}
            x={l.position.x - l.footprint!.w / 2}
            y={l.position.y - l.footprint!.h / 2}
            width={l.footprint!.w}
            height={l.footprint!.h}
            rx={14}
            fill={l.type === "parking" ? "var(--color-map-parking)" : "var(--color-map-building)"}
            stroke="var(--color-map-outline)"
            strokeDasharray={l.type === "parking" ? "6 5" : undefined}
          />
        ))}

      {/* Drivable paths */}
      <g stroke="var(--color-map-casing)" strokeWidth={fs * 1.1} strokeLinecap="round">
        {segments.map((s) => <line key={`w-${s.id}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />)}
      </g>
      <g stroke="var(--color-map-path)" strokeWidth={fs * 0.22} strokeLinecap="round">
        {segments.map((s) => <line key={s.id} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />)}
      </g>
      {/* Direction arrows on one-way paths, so the map does not suggest a two-way road. */}
      <g fill="none" stroke="var(--color-muted)" strokeWidth={fs * 0.22} strokeLinecap="round" strokeLinejoin="round">
        {segments
          .filter((s) => s.oneWay)
          .map((s) => {
            const d = oneWayArrow(s, fs * 0.9);
            return d ? <path key={`ow-${s.id}`} d={d} /> : null;
          })}
      </g>

      {/* Route the server planned for the current trip leg */}
      {route.size > 0 && (
        <g stroke="var(--color-brand)" strokeWidth={fs * 0.45} strokeLinecap="round" opacity={0.85}>
          {segments.filter((s) => route.has(s.id)).map((s) => <line key={`r-${s.id}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />)}
        </g>
      )}

      {campus.locations.map((l) => (
        <Marker key={l.id} loc={l} fs={fs} mapHeight={height} clear={ringed.has(l.id) || cartPoints.some((p) => near(p, l.position))} />
      ))}

      {pickup && <StopRing point={pickup} fs={fs} color="var(--color-brand)" label="Pickup" side="left" />}
      {destination && <StopRing point={destination} fs={fs} color="var(--color-dropoff)" label="Drop-off" />}
      {fanned.map(({ c, x, y }) => (
        <g key={`cart-${c.id}`}>
          <title>{`${c.label} (simulated position)`}</title>
          {c.highlight && <circle cx={x} cy={y} r={fs * 1.45} fill="none" stroke="var(--color-brand)" strokeWidth={fs * 0.25} />}
          <circle cx={x} cy={y} r={fs * 0.95} fill="var(--color-marker)" stroke="var(--color-map-bg)" strokeWidth={fs * 0.25} />
          <text x={x} y={y + fs * 0.32} textAnchor="middle" fontSize={fs * 0.8} fontWeight={800} fill="var(--color-marker-fg)">
            {c.label.replace(/\D+/g, "").slice(-2) || "C"}
          </text>
        </g>
      ))}
      {overlay?.cart && (
        <g>
          <title>{`${overlay.cart.label} (simulated position)`}</title>
          <circle cx={overlay.cart.point.x} cy={overlay.cart.point.y} r={fs * 0.95} fill="var(--color-marker)" stroke="var(--color-map-bg)" strokeWidth={fs * 0.25} />
          <path
            d={`M${overlay.cart.point.x - fs * 0.45} ${overlay.cart.point.y + fs * 0.15} h${fs * 0.9} M${overlay.cart.point.x - fs * 0.3} ${overlay.cart.point.y - fs * 0.25} h${fs * 0.6}`}
            stroke="var(--color-marker-fg)"
            strokeWidth={fs * 0.18}
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
}

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

/**
 * Pickup / Drop-off ring. Its label sits beside the ring (Pickup on the left, Drop-off on the right, so both
 * stay readable even on the same stop), clear of the location's own name below the ring.
 */
function StopRing({ point, fs, color, label, side = "right" }: { point: Point; fs: number; color: string; label: string; side?: "left" | "right" }) {
  return (
    <g>
      <circle cx={point.x} cy={point.y} r={fs * 1.25} fill="none" stroke={color} strokeWidth={fs * 0.3} />
      <text
        x={side === "right" ? point.x + fs * 1.65 : point.x - fs * 1.65}
        y={point.y + fs * 0.3}
        textAnchor={side === "right" ? "start" : "end"}
        fontSize={fs * 0.85}
        fontWeight={800}
        fill={color === "var(--color-brand)" ? "var(--color-brand-strong)" : color}
        paintOrder="stroke"
        stroke="var(--color-map-bg)"
        strokeWidth={fs * 0.3}
      >
        {label}
      </text>
    </g>
  );
}

function Marker({ loc, fs, clear = false, mapHeight }: { loc: Location; fs: number; clear?: boolean; mapHeight: number }) {
  const { x, y } = loc.position;
  const r = fs * 0.55;
  const label = loc.shortName ?? loc.name;
  return (
    <g>
      <title>{loc.name}</title>
      {loc.type === "pickup" && (
        <>
          <circle cx={x} cy={y} r={r * 1.25} fill="var(--color-map-casing)" stroke="var(--color-brand)" strokeWidth={r * 0.55} />
        </>
      )}
      {loc.type === "gate" && <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={r * 0.4} fill="var(--color-ink)" />}
      {loc.type === "building" && <circle cx={x} cy={y} r={r * 0.75} fill="var(--color-map-node)" />}
      {loc.type === "parking" && (
        <>
          <rect x={x - r * 1.1} y={y - r * 1.1} width={r * 2.2} height={r * 2.2} rx={r * 0.5} fill="var(--color-map-parking-sign)" />
          <text x={x} y={y + r * 0.55} textAnchor="middle" fontSize={r * 1.5} fontWeight={800} fill="white">P</text>
        </>
      )}
      {loc.type === "depot" && (
        <>
          <circle cx={x} cy={y} r={r * 1.15} fill="var(--color-accent)" />
          <path
            d={`M${x + r * 0.15} ${y - r * 0.75} L${x - r * 0.45} ${y + r * 0.1} H${x} L${x - r * 0.15} ${y + r * 0.75} L${x + r * 0.45} ${y - r * 0.1} H${x} Z`}
            fill="white"
          />
        </>
      )}
      <text
        x={x}
        y={!clear ? y + r * 2.6 : y + fs * 2.45 <= mapHeight - 4 ? y + fs * 2.45 : y - fs * 1.7}
        textAnchor="middle"
        fontSize={fs}
        fontWeight={loc.type === "building" ? 700 : 600}
        fill={loc.type === "pickup" ? "var(--color-brand-strong)" : "var(--color-ink)"}
        paintOrder="stroke"
        stroke="var(--color-map-bg)"
        strokeWidth={fs * 0.3}
      >
        {label}
      </text>
    </g>
  );
}
