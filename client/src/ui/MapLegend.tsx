import type { CampusConfig, LocationType } from "../../../shared/schemas";
import { LOCATION_TYPE_LABEL } from "../lib/mapGeometry";

const SWATCH: Record<LocationType, string> = {
  gate: "bg-ink rounded-[3px]",
  building: "bg-[#8a909c] rounded-full",
  parking: "bg-[#3b6fd8] rounded-[4px]",
  pickup: "bg-white ring-[3px] ring-brand rounded-full",
  depot: "bg-accent rounded-full",
};

export function MapLegend({ campus }: { campus: CampusConfig }) {
  const counts = new Map<LocationType, number>();
  for (const l of campus.locations) counts.set(l.type, (counts.get(l.type) ?? 0) + 1);
  const oneWay = campus.paths.filter((p) => p.oneWay).length;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
      {[...counts].map(([type, n]) => (
        <li key={type} className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-3 ${SWATCH[type]}`} />
          {LOCATION_TYPE_LABEL[type]} ({n})
        </li>
      ))}
      {oneWay > 0 && (
        <li className="flex items-center gap-1.5">
          <span className="inline-block text-[10px] leading-none font-bold" aria-hidden="true">&gt;</span>
          One-way path ({oneWay})
        </li>
      )}
    </ul>
  );
}
