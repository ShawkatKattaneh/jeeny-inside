/**
 * The Student App's, Driver Mode's and Operations Dashboard's calls to the existing ride-request REST API (Phase 2). Request bodies use the
 * shared CreateRideRequestBody shape (studentId, pickupId, destinationId, and from Phase 4 an optional
 * mode; the server creates ids, status, fare and timestamps). Successful responses are checked with the shared schemas; errors keep
 * the API's { error, code } body so the UI can show the server's own explanation.
 */
import { z } from "zod";
import { Cart, RideRequest, Trip, type AdvanceSimulationBody, type CreateRideRequestBody } from "../../../shared/schemas";

/** One open trip as the server's shared dispatch judged it (engine/dispatch.ts JoinCandidate). Read-only on the client. */
export const JoinCandidate = z.object({
  tripId: z.string(),
  cartId: z.string().nullable(),
  eligible: z.boolean(),
  excludedCode: z.string().optional(),
  excludedReason: z.string().optional(),
  /** For DELAY_CAP_EXCEEDED: the rider and measure (wait or journey) over the limit, in planned driving seconds. */
  worst: z.object({ requestId: z.string(), measure: z.enum(["wait", "journey"]), seconds: z.number() }).optional(),
  stage: z.enum(["planned", "moving"]).optional(),
  /** The trip's stop order (location ids) after the join, as planned by the server. */
  stopLocationIds: z.array(z.string()).optional(),
  /** Each affected rider's added planned driving time against their own solo baseline, as computed by the server. */
  riders: z.array(z.object({ requestId: z.string(), joining: z.boolean(), waitDelaySeconds: z.number().nullable(), journeyDelaySeconds: z.number() })).optional(),
  rank: z.number().optional(),
});
export type JoinCandidate = z.infer<typeof JoinCandidate>;

/**
 * The server's dispatch explanation (engine/dispatch.ts DispatchSelection), sent on a successful
 * dispatch and with 409 NO_CART_AVAILABLE. Checked here on the client; the server's shape is not changed.
 */
export const DispatchSelection = z.object({
  policy: z.string(),
  selectedCartId: z.string().nullable(),
  candidates: z.array(
    z.object({
      cartId: z.string(),
      eligible: z.boolean(),
      excludedCode: z.string().optional(),
      excludedReason: z.string().optional(),
      pickupEtaSeconds: z.number().optional(),
      pickupDistanceMeters: z.number().optional(),
      rank: z.number().optional(),
    }),
  ),
  // ---- Phase 4: present only on a shared request's selection (engine/dispatch.ts); a solo selection has none of these. ----
  mode: z.literal("shared").optional(),
  /** "joined": joined an existing trip; "new_cart": got its own cart; null: neither (with 409 NO_CART_AVAILABLE). */
  outcome: z.enum(["joined", "new_cart"]).nullable().optional(),
  selectedTripId: z.string().nullable().optional(),
  maxAddedDelaySeconds: z.number().optional(),
  /** Every open trip the server looked at, in trip id order, each eligible (with rank) or excluded (with a code and reason). */
  joinCandidates: z.array(JoinCandidate).optional(),
});
export type DispatchSelection = z.infer<typeof DispatchSelection>;

export type ApiResult<T> =
  | { ok: true; value: T }
  /** status is null when the server could not be reached at all. `selection` only on 409 NO_CART_AVAILABLE. */
  | { ok: false; status: number | null; code: string; message: string; selection?: DispatchSelection };

const ErrorBody = z.object({ error: z.string(), code: z.string(), selection: DispatchSelection.optional() });
const CancelResponse = z.object({ request: RideRequest });
/** Body of a successful start / board / drop-off call: the request, its trip and that trip's cart after the operation. */
const LifecycleResponse = z.object({ request: RideRequest, trip: Trip, cart: Cart });
export type LifecycleResult = z.infer<typeof LifecycleResponse>;

/** The driver-side ride operations that exist on the server (Phase 2): POST /api/ride-requests/:id/<action>. */
export type LifecycleAction = "start" | "board" | "drop-off";

export interface RideApi {
  /** POST /api/ride-requests: create a ride request; answers 201 with the new request. */
  createRideRequest(body: CreateRideRequestBody): Promise<ApiResult<RideRequest>>;
  /** POST /api/ride-requests/:id/cancel: cancel before boarding; answers with the updated request. */
  cancelRide(requestId: string): Promise<ApiResult<RideRequest>>;
}

const DispatchResponse = z.object({ request: RideRequest, trip: Trip, cart: Cart, selection: DispatchSelection });
export type DispatchResult = z.infer<typeof DispatchResponse>;
const AdvanceResponse = z.object({ clockSeconds: z.number().min(0), carts: z.array(Cart), trips: z.array(Trip) });
export type AdvanceResult = z.infer<typeof AdvanceResponse>;

/** Operations Dashboard's calls (Phase 3 Prompt 3): the two operator controls the server has. */
export interface OpsApi {
  /** POST /api/ride-requests/:id/dispatch (no body fields): the server picks and assigns a cart, or explains why none. */
  dispatch(requestId: string): Promise<ApiResult<DispatchResult>>;
  /** POST /api/simulation/advance { seconds }: moves simulated time for every moving trip. */
  advance(body: AdvanceSimulationBody): Promise<ApiResult<AdvanceResult>>;
}

/** Driver Mode's calls (Phase 3 Prompt 2). Separate from RideApi so the Student App's API is unchanged. */
export interface DriverApi {
  /** POST /api/ride-requests/:id/{start,board,drop-off}: one lifecycle step for one request; takes no body fields. */
  rideAction(requestId: string, action: LifecycleAction): Promise<ApiResult<LifecycleResult>>;
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
      ? { ok: false, status: res.status, code: err.data.code, message: err.data.error, ...(err.data.selection ? { selection: err.data.selection } : {}) }
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

export function createDriverApi(baseUrl = "", fetchImpl: typeof fetch = (...args) => fetch(...args)): DriverApi {
  return {
    rideAction: (requestId, action) =>
      call(fetchImpl, `${baseUrl}/api/ride-requests/${encodeURIComponent(requestId)}/${action}`, {}, (v) => LifecycleResponse.parse(v)),
  };
}

export function createOpsApi(baseUrl = "", fetchImpl: typeof fetch = (...args) => fetch(...args)): OpsApi {
  return {
    dispatch: (requestId) =>
      call(fetchImpl, `${baseUrl}/api/ride-requests/${encodeURIComponent(requestId)}/dispatch`, {}, (v) => DispatchResponse.parse(v)),
    advance: (body) => call(fetchImpl, `${baseUrl}/api/simulation/advance`, body, (v) => AdvanceResponse.parse(v)),
  };
}
