import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AdvanceSimulationBody, CreateRideRequestBody, EmptyActionBody, type CampusConfig, type Trip } from "../shared/schemas.js";
import { PERSONAS } from "../shared/personas.js";
import { SETTINGS, INDEPENDENCE_NOTE } from "../shared/settings.js";
import type { Fleet } from "../engine/fleet.js";
import { listCarts, getCart } from "../engine/fleet.js";
import { board, cancel, createRequest, dropOff, fail, getRequest, startTrip, tripForRequest, type RideError, type RideResult, type RideState } from "../engine/rides.js";
import { dispatchRequest, type DispatchError } from "../engine/dispatch.js";
import { advance } from "../engine/simulation.js";
import { createAppStore, type AppStore } from "./state.js";
import { registerErrorHandler, rideErrorResponse, validationErrorBody } from "./errors.js";

/** After a lifecycle operation: the ride's request, its trip and that trip's cart, from the new state. */
function withRide(requestId: string, r: RideResult<{ trip: Readonly<Trip> | null }>) {
  if (!r.ok) return r;
  const cart = r.trip ? r.state.fleet.carts.get(r.trip.cartId) ?? null : null;
  return { ...r, request: r.state.requests.get(requestId)!, cart };
}

/** Send an apply result: the success projection, or the centrally mapped error. */
function sendResult<R extends { ok: true } | { ok: false; error: RideError | DispatchError }>(
  reply: FastifyReply,
  result: R,
  project: (r: Extract<R, { ok: true }>) => unknown,
) {
  if (!result.ok) {
    const { status, body } = rideErrorResponse((result as { error: RideError | DispatchError }).error);
    return reply.code(status).send(body);
  }
  return reply.send(project(result as Extract<R, { ok: true }>));
}

/**
 * Either the validated campus and starting fleet (the app builds its own state from them), or a store
 * that was already initialized with createAppStore (tests use this to start from a prepared state).
 */
export type AppOptions = (
  | {
      campus: CampusConfig;
      /** The validated starting fleet for this campus (see server/fleet.ts loadFleet). */
      fleet: Fleet;
      store?: never;
    }
  | { store: AppStore; campus?: never; fleet?: never }
) & {
  /** Serve the built client from this folder (production / demo mode). */
  clientDir?: string;
  logger?: boolean;
};

/**
 * The server: read-only Phase 0 endpoints, the Phase 2 ride-request API over the engine, and, in demo
 * mode, the built web app. Each call builds one app with its own authoritative state (server/state.ts);
 * server/index.ts calls it once. Routes hold no business rules: they validate the payload shape, run
 * engine operations through the store, and map engine errors (server/errors.ts).
 * Dispatch is explicit (one request per call) and simulated time moves only when a client calls
 * /api/simulation/advance: there are no timers or background loops. State is in memory only.
 * Socket.IO and SQLite arrive with the phases that need them.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { clientDir, logger = false } = options;
  // Throws (and the server does not start) if the engine refuses this campus and fleet.
  const store: AppStore = options.store ?? createAppStore(options.campus, options.fleet);
  const app = Fastify({ logger });
  registerErrorHandler(app);

  app.get("/api/health", async () => ({ ok: true, campus: store.read((s) => s.campus.id), time: Date.now() }));
  app.get("/api/campus", async () => store.read((s) => s.campus));
  app.get("/api/personas", async () => PERSONAS);
  app.get("/api/about", async () => ({ note: INDEPENDENCE_NOTE, settings: SETTINGS }));

  // ---------- Fleet (read-only) ----------

  app.get("/api/carts", async () => store.read((s) => listCarts(s.fleet)));

  app.get<{ Params: { cartId: string } }>("/api/carts/:cartId", async (req, reply) => {
    const found = store.read((s) => getCart(s.fleet, req.params.cartId));
    if (!found.ok) {
      const { status, body } = rideErrorResponse(fail("UNKNOWN_CART", found.error.message).error);
      return reply.code(status).send(body);
    }
    return found.cart;
  });

  // ---------- Ride requests ----------

  app.post("/api/ride-requests", async (req, reply) => {
    const body = CreateRideRequestBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationErrorBody(body.error, "ride request"));
    const result = store.apply((s) => createRequest(s, body.data));
    if (!result.ok) {
      const { status, body: err } = rideErrorResponse(result.error);
      return reply.code(status).send(err);
    }
    return reply.code(201).send(result.request);
  });

  app.get<{ Params: { requestId: string } }>("/api/ride-requests/:requestId", async (req, reply) => {
    const found = store.read((s) => getRequest(s, req.params.requestId));
    if (!found.ok) {
      const { status, body } = rideErrorResponse(found.error);
      return reply.code(status).send(body);
    }
    return found.request;
  });

  /** The trip carrying this request, or `{ trip: null }` while no cart has been assigned. */
  app.get<{ Params: { requestId: string } }>("/api/ride-requests/:requestId/trip", async (req, reply) => {
    const found = store.read((s) => {
      const r = getRequest(s, req.params.requestId);
      return r.ok ? { ok: true as const, trip: tripForRequest(s, r.request.id) ?? null } : r;
    });
    if (!found.ok) {
      const { status, body } = rideErrorResponse(found.error);
      return reply.code(status).send(body);
    }
    return { trip: found.trip };
  });

  // ---------- Dispatch and ride execution (Prompt 2) ----------
  // Each action runs exactly one engine operation through the store and takes no body fields.
  // Boarding and drop-off stay explicit: advancing the simulation never boards or drops anyone off.

  type RideParams = { Params: { requestId: string } };
  const action = (
    path: string,
    op: (s: RideState, requestId: string) => RideResult<{ trip: Readonly<Trip> | null }>,
  ) =>
    app.post<RideParams>(`/api/ride-requests/:requestId/${path}`, async (req, reply) => {
      const body = EmptyActionBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send(validationErrorBody(body.error, `${path} call (it takes no fields)`));
      const id = req.params.requestId;
      const result = store.apply((s) => withRide(id, op(s, id)));
      return sendResult(reply, result, (r) => ({ request: r.request, trip: r.trip, cart: r.cart }));
    });

  /** Pick a cart with the deterministic policy (engine/dispatch.ts) and assign it. 409 NO_CART_AVAILABLE explains every cart. */
  app.post<RideParams>("/api/ride-requests/:requestId/dispatch", async (req, reply) => {
    const body = EmptyActionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationErrorBody(body.error, "dispatch call (it takes no fields)"));
    const id = req.params.requestId;
    const result = store.apply((s) => {
      const r = dispatchRequest(s, id);
      return r.ok ? { ...r, request: r.state.requests.get(id)!, cart: r.state.fleet.carts.get(r.trip.cartId)! } : r;
    });
    return sendResult(reply, result, (r) => ({ request: r.request, trip: r.trip, cart: r.cart, selection: r.selection }));
  });

  action("start", (s, id) => startTrip(s, id));
  action("board", (s, id) => board(s, id));
  action("drop-off", (s, id) => dropOff(s, id));
  action("cancel", (s, id) => cancel(s, id));

  // ---------- Simulation (manual demo clock) ----------

  /**
   * Advance simulated time by `seconds` for every active and cancelling trip at once (engine
   * `advance`: all or nothing). This is a manual demo control, not real-time movement.
   * Returns the new clock, every cart, and the new version of each trip that was moving.
   */
  app.post("/api/simulation/advance", async (req, reply) => {
    const body = AdvanceSimulationBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationErrorBody(body.error, "simulation step"));
    const result = store.apply((s) => {
      const moving = [...s.trips.values()].filter((t) => t.status === "active" || t.status === "cancelling").map((t) => t.id).sort();
      const r = advance(s, body.data.seconds);
      if (!r.ok) return r;
      return { ...r, clockSeconds: r.state.clockSeconds, carts: listCarts(r.state.fleet), trips: moving.map((id) => r.state.trips.get(id)!) };
    });
    return sendResult(reply, result, (r) => ({ clockSeconds: r.clockSeconds, carts: r.carts, trips: r.trips }));
  });

  if (clientDir && existsSync(resolve(clientDir, "index.html"))) {
    await app.register(fastifyStatic, { root: resolve(clientDir), wildcard: false });
    // Client-side routes (/student, /driver, /ops) all load the single-page app.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return app;
}
