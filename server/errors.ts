/**
 * One place that turns engine and request errors into HTTP responses.
 * Body shape for every API error: { error: "<readable message>", code: "<STABLE_CODE>" }, plus
 * `issues` for payload validation. This keeps the Phase 0 `{ error }` shape and adds a stable code.
 * Internal errors never carry stack traces or engine state.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodError } from "zod";
import type { RideError } from "../engine/rides.js";
import type { DispatchError, DispatchErrorCode, DispatchSelection } from "../engine/dispatch.js";

export interface ApiErrorBody {
  error: string;
  code: string;
  issues?: { path: string; message: string }[];
  /** NO_CART_AVAILABLE only: every cart and why the engine refused it. */
  selection?: DispatchSelection;
}

/**
 * Engine error code -> HTTP status. A Record over every code, so a new engine code fails the type
 * check until it is mapped here.
 * - 400: the request itself is invalid (bad fields, unknown or non-stop location, same pickup and destination).
 * - 404: the resource named in the URL does not exist.
 * - 409: a valid request the current ride state does not allow, including "no cart can take this ride now".
 * - 500: the engine refused because its own state would become inconsistent (a bug, not the caller's fault).
 */
const STATUS_BY_CODE: Record<DispatchErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNKNOWN_LOCATION: 400,
  NOT_A_STOP: 400,
  SAME_LOCATION: 400,
  INVALID_CART_UPDATE: 400,
  UNKNOWN_REQUEST: 404,
  UNKNOWN_CART: 404,
  NO_ROUTE: 409,
  CART_ON_TRIP: 409,
  CART_ALREADY_ASSIGNED: 409,
  CART_INELIGIBLE: 409,
  CART_NOT_AT_LOCATION: 409,
  INVALID_TRANSITION: 409,
  ALREADY_ARRIVED: 409,
  UNKNOWN_TRIP: 404,
  RIDE_FINISHED: 409,
  CANNOT_CANCEL_ON_BOARD: 409,
  ALREADY_CANCELLING: 409,
  NOT_AT_STOP: 409,
  NO_CART_AVAILABLE: 409,
  // Phase 4: a shared request cannot join a trip (also listed per trip in a dispatch selection).
  REQUEST_NOT_SHARED: 409,
  TRIP_NOT_JOINABLE: 409,
  STAGE_NOT_ALLOWED: 409,
  TRIP_NOT_SHARED: 409,
  SAME_STUDENT: 409,
  TRIP_FULL: 409,
  SOLO_BASELINE_UNAVAILABLE: 409,
  RIDER_BASELINE_MISSING: 409,
  ROUTE_METRIC_UNAVAILABLE: 409,
  DELAY_CAP_EXCEEDED: 409,
  // Phase 4 Tap-In (approved contract): a bad point in the body is 400; a refusal by ride state is 409.
  UNKNOWN_POINT: 400,
  POINT_NOT_SUPPORTED: 400,
  NOT_YOUR_RIDE: 409,
  TAP_IN_NOT_ALLOWED: 409,
  PICKUP_MISMATCH: 409,
  INVALID_MOVEMENT: 500,
  INCONSISTENT_STATE: 500,
};

const INTERNAL: ApiErrorBody = { error: "Internal server error", code: "INTERNAL_ERROR" };

/** Status and body for an engine error. 500s get a generic message; the details go to the server log only. */
export function rideErrorResponse(err: RideError | DispatchError): { status: number; body: ApiErrorBody } {
  const status = STATUS_BY_CODE[err.code] ?? 500;
  if (status >= 500) {
    // The engine refused because its own state would break: a bug. Details go to the console only.
    console.error(`[api] engine error ${err.code}: ${err.message}`);
    return { status, body: INTERNAL };
  }
  const selection = "selection" in err ? err.selection : undefined;
  return { status, body: selection ? { error: err.message, code: err.code, selection } : { error: err.message, code: err.code } };
}

/** Body for a payload that fails its Zod schema, listing every problem (including unrecognized fields). */
export function validationErrorBody(err: ZodError, what: string): ApiErrorBody {
  const issues = err.issues.map((i) => ({
    path: i.path.map(String).join(".") || "(body)",
    message: i.code === "unrecognized_keys" ? `Field(s) not allowed: ${i.keys.join(", ")}` : i.message,
  }));
  return { error: `Invalid ${what}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, code: "INVALID_REQUEST", issues };
}

/**
 * Fastify-level errors (malformed JSON, wrong content type, body too large, thrown exceptions) in the
 * same body shape. Client errors keep Fastify's status; anything else is a 500 with a generic message.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(sendFastifyError);
}

/** The app-wide handler's response for one Fastify-level error (shared so a route can fall back to it). */
export function sendFastifyError(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const status = typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  if (status >= 500) {
    // Details stay in the server console; the response never carries them.
    console.error(`[api] ${req.method} ${req.url} failed:`, err);
    return reply.code(500).send(INTERNAL);
  }
  return reply.code(status).send({ error: err.message, code: err.code ?? "BAD_REQUEST" } satisfies ApiErrorBody);
}

/** Fastify's codes for a JSON content type whose body is not valid JSON (malformed, or empty). */
const MALFORMED_JSON_CODES = new Set(["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"]);

/**
 * Phase 4 Tap-In route only (approved audit fix F1): a malformed JSON body is the contract's
 * 400 INVALID_REQUEST. Every other error goes to the app-wide handler unchanged, and no other route uses this.
 */
export function tapInErrorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (err.code && MALFORMED_JSON_CODES.has(err.code)) {
    return reply.code(400).send({ error: "Invalid Tap-In: the body is not valid JSON (it takes exactly studentId, campusId and pointId)", code: "INVALID_REQUEST" } satisfies ApiErrorBody);
  }
  return sendFastifyError(err, req, reply);
}
