import { useEffect, useState } from "react";
import { RideEtaResponse } from "../../../shared/schemas";

/**
 * The server's ETA for a ride with a cart (GET /api/ride-requests/:id/eta, the engine's own estimate on
 * the simulated route). Re-asked whenever the live revision changes; an older answer never replaces a
 * newer one. Read-only: it never writes into the live state.
 */
export function useRideEta(requestId: string | null, revision: number | null, enabled = true): RideEtaResponse | null {
  const [eta, setEta] = useState<RideEtaResponse | null>(null);
  useEffect(() => {
    if (!requestId || !enabled || revision === null) { setEta(null); return; }
    let live = true;
    fetch(`/api/ride-requests/${encodeURIComponent(requestId)}/eta`)
      .then(async (r) => (r.ok ? RideEtaResponse.parse(await r.json()) : null))
      .then((v) => { if (live) setEta((cur) => (v && (!cur || v.revision >= cur.revision) ? v : v === null ? null : cur)); })
      .catch(() => { if (live) setEta(null); });
    return () => { live = false; };
  }, [requestId, revision, enabled]);
  return eta;
}

/** "under 1 min" or "N min", rounded up. */
export function etaText(seconds: number): string {
  return seconds < 60 ? "under 1 min" : `${Math.ceil(seconds / 60)} min`;
}
