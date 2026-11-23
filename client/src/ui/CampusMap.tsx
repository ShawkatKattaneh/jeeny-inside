import type { CampusConfig, Location } from "../../../shared/schemas";
import { labelSize, oneWayArrow, pathSegments } from "../lib/mapGeometry";

/**
 * The campus map, drawn entirely from the campus config file (D3).
 * Desaturated light-gray base, thin paths, the plan's marker grammar.
 * Phase 0 shows the static campus; carts and routes are drawn from Phase 2 on.
 */
export function CampusMap({ campus, className = "" }: { campus: CampusConfig; className?: string }) {
  const { width, height } = campus.map;
  const fs = labelSize(campus);
  const segments = pathSegments(campus);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`block h-auto w-full rounded-tile bg-map-bg ${className}`}
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
            fill={l.type === "parking" ? "#e7e9ec" : "var(--color-map-building)"}
            stroke="#d3d7dc"
            strokeDasharray={l.type === "parking" ? "6 5" : undefined}
          />
        ))}

      {/* Drivable paths */}
      <g stroke="#ffffff" strokeWidth={fs * 1.1} strokeLinecap="round">
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

      {campus.locations.map((l) => <Marker key={l.id} loc={l} fs={fs} />)}
    </svg>
  );
}

function Marker({ loc, fs }: { loc: Location; fs: number }) {
  const { x, y } = loc.position;
  const r = fs * 0.55;
  const label = loc.shortName ?? loc.name;
  return (
    <g>
      <title>{loc.name}</title>
      {loc.type === "pickup" && (
        <>
          <circle cx={x} cy={y} r={r * 1.25} fill="white" stroke="var(--color-brand)" strokeWidth={r * 0.55} />
        </>
      )}
      {loc.type === "gate" && <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={r * 0.4} fill="var(--color-ink)" />}
      {loc.type === "building" && <circle cx={x} cy={y} r={r * 0.75} fill="#8a909c" />}
      {loc.type === "parking" && (
        <>
          <rect x={x - r * 1.1} y={y - r * 1.1} width={r * 2.2} height={r * 2.2} rx={r * 0.5} fill="#3b6fd8" />
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
        y={y + r * 2.6}
        textAnchor="middle"
        fontSize={fs}
        fontWeight={loc.type === "building" ? 700 : 600}
        fill={loc.type === "pickup" ? "var(--color-brand)" : "var(--color-ink)"}
        paintOrder="stroke"
        stroke="var(--color-map-bg)"
        strokeWidth={fs * 0.3}
      >
        {label}
      </text>
    </g>
  );
}
