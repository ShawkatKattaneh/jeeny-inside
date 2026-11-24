/**
 * One place that turns engine and request errors into HTTP responses.
 * Body shape for every API error: { error: "<readable message>", code: "<STABLE_CODE>" }, plus
 * `issues` for payload validation. This keeps the Phase 0 `{ error }` shape and adds a stable code.
 * Internal errors never carry stack traces or engine state.
 */
import type { FastifyError, FastifyInstance } from "fastify";
import type { ZodError } from "zod";
import type { RideError, RideErrorCode } from "../engine/rides.js";

export interface ApiErrorBody {
  error: string;
  code: string;
  issues?: { path: string; message: string }[];
}

/**
 * Engine error code -> HTTP status. A Record over every code, so a new engine code fails the type
 * check until it is mapped here.
 * - 400: the request itself is invalid (bad fields, unknown or non-stop location, same pickup and destination).
 * - 404: the resource named in the URL does not exist.
 * - 409: a valid request the current ride state does not allow.
 * - 500: the engine refused because its own state would become inconsistent (a bug, not the caller's fault).
 */
const STATUS_BY_CODE: Record<RideErrorCode, number> = {
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
  RIDE_FINISHED: 409,
  CANNOT_CANCEL_ON_BOARD: 409,
  ALREADY_CANCELLING: 409,
  NOT_AT_STOP: 409,
  INVALID_MOVEMENT: 500,
  INCONSISTENT_STATE: 500,
};

const INTERNAL: ApiErrorBody = { error: "Internal server error", code: "INTERNAL_ERROR" };

/** Status and body for an engine error. 500s get a generic message; the details go to the server log only. */
export function rideErrorResponse(err: RideError): { status: number; body: ApiErrorBody } {
  const status = STATUS_BY_CODE[err.code] ?? 500;
  return status >= 500 ? { status, body: INTERNAL } : { status, body: { error: err.message, code: err.code } };
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
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      // Details stay in the server console; the response never carries them.
      console.error(`[api] ${req.method} ${req.url} failed:`, err);
      return reply.code(500).send(INTERNAL);
    }
    return reply.code(status).send({ error: err.message, code: err.code ?? "BAD_REQUEST" } satisfies ApiErrorBody);
  });
}
