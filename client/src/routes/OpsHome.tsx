import { useCampus } from "../lib/campusContext";
import { LOCATION_TYPE_LABEL } from "../lib/mapGeometry";
import { Badge } from "../ui/Badge";
import { CampusMap } from "../ui/CampusMap";
import { Card } from "../ui/Card";
import { MapLegend } from "../ui/MapLegend";
import { AreaLayout, ComingNext } from "./AreaLayout";

export function OpsHome() {
  const campus = useCampus();
  return (
    <AreaLayout role="operator" wide>
      {() => (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-extrabold tracking-tight">Operations Center</h1>
              <Badge>Sample data</Badge>
            </div>
            <CampusMap campus={campus} />
            <MapLegend campus={campus} />
            <ComingNext phase="Phase 2" text="live carts on the map, request queue, 3 KPIs, the decision log and simulation controls." />
          </section>
          <Card className="flex max-h-[70vh] flex-col overflow-hidden">
            <div className="border-b border-line px-4 py-3">
              <div className="text-sm font-bold">{campus.name}</div>
              <div className="text-xs text-muted">
                {campus.locations.length} locations · {campus.paths.length} paths{campus.fictional ? " · fictional" : ""}
              </div>
            </div>
            <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
              {campus.locations.map((l) => (
                <li key={l.id} className="flex items-center justify-between px-4 py-2">
                  <span className="font-medium">{l.name}</span>
                  <span className="text-xs text-muted">{LOCATION_TYPE_LABEL[l.type]}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </AreaLayout>
  );
}
