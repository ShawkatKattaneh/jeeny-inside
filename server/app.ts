import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CreateRideRequestBody, type CampusConfig } from "../shared/schemas.js";
import { PERSONAS } from "../shared/personas.js";
import { SETTINGS, INDEPENDENCE_NOTE } from "../shared/settings.js";
import type { Fleet } from "../engine/fleet.js";
import { listCarts, getCart } from "../engine/fleet.js";
import { createRequest, fail, getRequest, tripForRequest } from "../engine/rides.js";
import { createAppStore, type AppStore } from "./state.js";
import { registerErrorHandler, rideErrorResponse, validationErrorBody } from "./errors.js";

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
 * Dispatch, movement, Socket.IO and SQLite arrive with the phases that need them.
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
