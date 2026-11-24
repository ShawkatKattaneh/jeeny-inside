import type { Persona } from "../../../shared/schemas";
import { RealtimeProvider } from "../lib/realtimeContext";
import type { RealtimeStore } from "../lib/realtimeStore";
import type { OpsApi } from "../lib/rideApi";
import { OpsDashboard } from "../ops/OpsDashboard";
import { AreaLayout } from "./AreaLayout";

/**
 * Operations Dashboard (/ops), demo operator persona only. One realtime connection for the area, opened
 * on entry and closed on exit (same RealtimeProvider and store as Student and Driver).
 * `store`, `api` and `personas` are for tests; the app uses the real socket and REST API.
 */
export function OpsHome({ store, api, personas }: { store?: RealtimeStore; api?: OpsApi; personas?: Persona[] } = {}) {
  return (
    <AreaLayout role="operator" wide>
      {() => (
        <RealtimeProvider store={store}>
          <div className="flex flex-col gap-4">
            <OpsDashboard api={api} personas={personas} />
          </div>
        </RealtimeProvider>
      )}
    </AreaLayout>
  );
}
