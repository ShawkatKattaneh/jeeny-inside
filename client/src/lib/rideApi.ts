/**
 * The Student App's calls to the existing ride-request REST API (Phase 2). Request bodies use the
 * shared CreateRideRequestBody shape (studentId, pickupId, destinationId only: the server creates ids,
 * status, fare and timestamps). Successful responses are checked with the shared schemas; errors keep
 * the API's { error, code } body so the UI can show the server's own explanation.
 */
import { z } from "zod";
import { RideRequest, type CreateRideRequestBody } from "../../../shared/schemas";

export type ApiResult<T> =
  | { ok: true; value: T }
  /** status is null when the server could not be reached at all. */
  | { ok: false; status: number | null; code: string; message: string };

const ErrorBody = z.object({ error: z.string(), code: z.string() });
const CancelResponse = z.object({ request: RideRequest });

export interface RideApi {
  /** POST /api/ride-requests: create a ride request; answers 201 with the new request. */
  createRideRequest(body: CreateRideRequestBody): Promise<ApiResult<RideRequest>>;
  /** POST /api/ride-requests/:id/cancel: cancel before boarding; answers with the updated request. */
  cancelRide(requestId: string): Promise<ApiResult<RideRequest>>;
}

const UNREACHABLE = "Couldn't reach the Jeeny INSIDE server. Check that this device is on the same network as the server and try again.";

async function call<T>(fetchImpl: typeof fetch, url: string, body: unknown, parse: (v: unknown) => T): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: null, code: "NETWORK_ERROR", message: UNREACHABLE };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty or non-JSON body: handled below */
  }
  if (!res.ok) {
    const err = ErrorBody.safeParse(json);
    return err.success
      ? { ok: false, status: res.status, code: err.data.code, message: err.data.error }
      : { ok: false, status: res.status, code: "UNEXPECTED_RESPONSE", message: `The server answered ${res.status}.` };
  }
  try {
    return { ok: true, value: parse(json) };
  } catch {
    return { ok: false, status: res.status, code: "UNEXPECTED_RESPONSE", message: "The server's answer was not in the expected format." };
  }
}

/** `baseUrl` is "" in the browser (same origin, or the Vite proxy); tests pass a real server's URL. */
export function createRideApi(baseUrl = "", fetchImpl: typeof fetch = (...args) => fetch(...args)): RideApi {
  return {
    createRideRequest: (body) => call(fetchImpl, `${baseUrl}/api/ride-requests`, body, (v) => RideRequest.parse(v)),
    cancelRide: (requestId) =>
      call(fetchImpl, `${baseUrl}/api/ride-requests/${encodeURIComponent(requestId)}/cancel`, {}, (v) => CancelResponse.parse(v).request),
  };
}
