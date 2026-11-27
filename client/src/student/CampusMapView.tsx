import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { stopLocations } from "../lib/booking";
import { LOCATION_TYPE_LABEL } from "../lib/mapGeometry";
import { cartMapPoint, routePathIds } from "../lib/studentRides";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { MapLegend } from "../ui/MapLegend";
import { StudentPage } from "./StudentPage";
import { MAP_NOTE } from "./StudentMap";
import { useStudent } from "./studentContext";

/**
 * Campus Map: every stop from the campus file. Choosing a stop rings it on the map; "Set as pickup" or
 * "Set as destination" opens Home with that stop filled in (the booking itself still happens on Home).
 * With an active ride the map shows that ride instead, and stops cannot be set.
 */
export function CampusMapView() {
  const { campus, activeRide } = useStudent();
  const navigate = useNavigate();
  const stops = stopLocations(campus);
  const [selected, setSelected] = useState<string>("");
  const point = activeRide?.cart ? cartMapPoint(campus, activeRide.cart.position) : null;
  const sel = stops.find((s) => s.id === selected) ?? null;
  return (
    <StudentPage id="map-title" title="Campus map" intro={campus.name}>
      <figure className="flex flex-col gap-2 rounded-card bg-card p-2 ring-1 ring-line">
        <CampusMap
          campus={campus}
          overlay={activeRide
            ? { pickupId: activeRide.request.pickupId, destinationId: activeRide.request.destinationId, routePathIds: routePathIds(activeRide), cart: activeRide.cart && point ? { label: activeRide.cart.label, point } : null }
            : { pickupId: selected || null }}
        />
        <figcaption className="px-2 pb-1 text-[13px] text-muted">{MAP_NOTE}</figcaption>
      </figure>
      <div role="group" aria-label="Map legend"><MapLegend campus={campus} /></div>

      {activeRide ? (
        <p className="rounded-card bg-brand-tint px-4 py-3 text-[14px] text-ink" data-testid="map-active-ride">
          You have an active ride, so the map shows its pickup, drop-off and your cart. Follow it on Home.
        </p>
      ) : (
        <section aria-labelledby="map-stops" className="flex flex-col gap-2">
          <h2 id="map-stops" className="text-[17px] font-bold">Choose a stop</h2>
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card bg-card ring-1 ring-line" role="radiogroup" aria-labelledby="map-stops">
            {stops.map((s) => {
              const on = s.id === selected;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setSelected(on ? "" : s.id)}
                    className={`flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 ${on ? "bg-brand-tint" : "hover:bg-surface"}`}
                  >
                    <span className={`inline-block h-3 w-3 shrink-0 rounded-full ${on ? "bg-brand" : "ring-2 ring-inset ring-muted"}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold">{s.name}</span>
                      <span className="block text-[13px] text-muted">{LOCATION_TYPE_LABEL[s.type]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] grid grid-cols-2 gap-2 rounded-card bg-card p-2 shadow-pop ring-1 ring-line">
            <button type="button" disabled={!sel} onClick={() => navigate("/student", { state: { pickupId: selected } })} className="min-h-12 rounded-full bg-brand px-3 text-[15px] font-bold text-white disabled:bg-surface disabled:text-muted disabled:ring-1 disabled:ring-inset disabled:ring-line" data-testid="map-set-pickup">
              Set as pickup
            </button>
            <button type="button" disabled={!sel} onClick={() => navigate("/student", { state: { destinationId: selected } })} className="min-h-12 rounded-full bg-card px-3 text-[15px] font-bold text-ink ring-1 ring-line disabled:text-muted" data-testid="map-set-destination">
              Set as destination
            </button>
            <p className="col-span-2 px-1 text-center text-[13px] text-muted" aria-live="polite">{sel ? `${sel.name} selected.` : "Choose a stop above."}</p>
          </div>
        </section>
      )}
    </StudentPage>
  );
}
