import type { Persona } from "../../../shared/schemas";
import { DriverDashboard } from "../driver/DriverDashboard";
import { RealtimeProvider } from "../lib/realtimeContext";
import type { RealtimeStore } from "../lib/realtimeStore";
import type { DriverApi } from "../lib/rideApi";
import { AreaLayout } from "./AreaLayout";

/**
 * Driver Mode (/driver). One realtime connection for the area, opened when a driver persona enters and
 * closed when they leave (same RealtimeProvider and store as the Student App).
 * `store`, `api` and `personas` are for tests; the app uses the real socket and REST API.
 */
export function DriverHome({ store, api, personas }: { store?: RealtimeStore; api?: DriverApi; personas?: Persona[] } = {}) {
  return (
    <AreaLayout role="driver" wide>
      {(p) => (
        <RealtimeProvider store={store}>
          <DriverDashboard persona={p} api={api} personas={personas} />
        </RealtimeProvider>
      )}
    </AreaLayout>
  );
}
