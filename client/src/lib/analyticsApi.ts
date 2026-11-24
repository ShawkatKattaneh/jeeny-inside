/**
 * Operations dashboard: loading campus analytics (Phase 5 Prompt 2) from GET /api/analytics.
 * The response is validated with the shared schema; nothing is computed or filled in on the client.
 * A newer revision replaces an older one, and a slow, older reply never replaces a newer result.
 */
import { AnalyticsResponse } from "../../../shared/analytics";

export type AnalyticsLoad =
  | { status: "loading" }
  | { status: "ready"; data: AnalyticsResponse }
  /** `data` is the last good result, kept (and labelled as older) when a refresh fails. */
  | { status: "error"; message: string; data: AnalyticsResponse | null };

export type FetchAnalytics = () => Promise<AnalyticsResponse>;

export function createFetchAnalytics(baseUrl = "", fetchImpl: typeof fetch = (...args) => fetch(...args)): FetchAnalytics {
  return async () => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/api/analytics`);
    } catch {
      throw new Error("Could not reach the server.");
    }
    if (!res.ok) throw new Error(`The server answered ${res.status}.`);
    const parsed = AnalyticsResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error("The server's analytics response did not have the expected shape.");
    return parsed.data;
  };
}

/** Next state after a reply. An older revision than the one shown is ignored. */
export function applyAnalyticsReply(current: AnalyticsLoad, reply: { ok: true; data: AnalyticsResponse } | { ok: false; message: string }): AnalyticsLoad {
  const shown = current.status === "ready" ? current.data : current.status === "error" ? current.data : null;
  if (!reply.ok) return { status: "error", message: reply.message, data: shown };
  if (shown && reply.data.revision < shown.revision) return current;
  return { status: "ready", data: reply.data };
}
