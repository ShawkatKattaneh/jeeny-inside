import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AdvanceSimulationBody, AutoAdvanceBody, CreateRideRequestBody, MissionRunBody, EmptyActionBody, TapInBody, type CampusConfig, type StateOperation, type Trip } from "../shared/schemas.js";
import { PERSONAS } from "../shared/personas.js";
import { SETTINGS, INDEPENDENCE_NOTE } from "../shared/settings.js";
import type { Fleet } from "../engine/fleet.js";
import { listCarts, getCart } from "../engine/fleet.js";
import { board, cancel, confirmArrival, createRequest, dropOff, fail, getRequest, legMetersLeft, rideEta, routeDrivingSeconds, startTrip, tripForRequest, type RideError, type RideResult, type RideState } from "../engine/rides.js";
import { dispatchRequest, type DispatchError } from "../engine/dispatch.js";
import { tapIn } from "../engine/tapIn.js";
import { advance } from "../engine/simulation.js";
import { computeAnalytics } from "../engine/analytics.js";
import { runMission } from "../engine/mission.js";
import { AnalyticsQuery } from "../shared/analytics.js";
import { createAppStore, type AppStore } from "./state.js";
import { attachRealtime, snapshotOf } from "./realtime.js";
import { registerErrorHandler, rideErrorResponse, tapInErrorHandler, validationErrorBody } from "./errors.js";

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
 * Either the validated campus and starting fleet (the app builds its own store on a fresh in-memory
 * database), or a store that was already opened: openAppStore on the database file in production
 * (server/index.ts), or createAppStore in tests that start from a prepared state.
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
  /**
   * Phase 4 Tap-In: the public base URL that NFC tags and QR codes open ("http://<public host>:<port>"),
   * from --public-host= / PUBLIC_HOST (server/index.ts). null when no host is configured.
   */
  tapBaseUrl?: string | null;
};

/**
 * The server: read-only Phase 0 endpoints, the Phase 2 ride-request API over the engine, and, in demo
 * mode, the built web app. Each call builds one app with its own authoritative state (server/state.ts);
 * server/index.ts calls it once. Routes hold no business rules: they validate the payload shape, run
 * engine operations through the store, and map engine errors (server/errors.ts).
 * Dispatch is explicit (one request per call) and simulated time moves only when a client calls
 * /api/simulation/advance: there are no timers or background loops.
 * Realtime: Socket.IO shares this app's HTTP server (server/realtime.ts).
 * Persistence (Phase 5): every committed operation is saved to SQLite before it answers (server/state.ts).
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { clientDir, logger = false, tapBaseUrl = null } = options;
  // Throws (and the server does not start) if the engine refuses this campus and fleet.
  const store: AppStore = options.store ?? createAppStore(options.campus, options.fleet);
  const app = Fastify({ logger });
  // A store built here (in-memory database) closes with the app; a store passed in belongs to the caller.
  if (!options.store) app.addHook("onClose", async () => store.close());
  registerErrorHandler(app);
  // Socket.IO on this app's own HTTP server: pushes one "state:update" per committed operation.
  attachRealtime(app, store);

  app.get("/api/health", async () => ({ ok: true, campus: store.read((s) => s.campus.id), time: Date.now() }));
  app.get("/api/campus", async () => store.read((s) => s.campus));
  app.get("/api/personas", async () => PERSONAS);
  app.get("/api/about", async () => ({ note: INDEPENDENCE_NOTE, settings: SETTINGS, tapBaseUrl }));

  /** The whole ride state with its revision: the authoritative resync point for realtime clients. */
  app.get("/api/snapshot", async () => store.read(snapshotOf));

  /**
   * Phase 5 Prompt 2: campus analytics over the committed ride state (engine/analytics.ts). Read-only:
   * store.read runs a pure function on the last committed state (the same data the database holds) and
   * hands back a copy, so no operation runs, nothing is written, no revision moves and no update is sent.
   * Takes no query parameters.
   */
  app.get("/api/analytics", async (req, reply) => {
    const query = AnalyticsQuery.safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send(validationErrorBody(query.error, "analytics query (it takes no parameters)"));
    return store.read((s, revision) => computeAnalytics(s, revision));
  });

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
    const result = store.apply((s) => createRequest(s, body.data), "ride_request.created");
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
    operation: StateOperation,
    op: (s: RideState, requestId: string) => RideResult<{ trip: Readonly<Trip> | null }>,
  ) =>
    app.post<RideParams>(`/api/ride-requests/:requestId/${path}`, async (req, reply) => {
      const body = EmptyActionBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send(validationErrorBody(body.error, `${path} call (it takes no fields)`));
      const id = req.params.requestId;
      const result = store.apply((s) => withRide(id, op(s, id)), operation);
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
    }, "ride.dispatched");
    return sendResult(reply, result, (r) => ({ request: r.request, trip: r.trip, cart: r.cart, selection: r.selection }));
  });

  action("start", "ride.started", (s, id) => startTrip(s, id));
  action("board", "ride.boarded", (s, id) => board(s, id));
  action("drop-off", "ride.dropped_off", (s, id) => dropOff(s, id));
  action("cancel", "ride.cancelled", (s, id) => cancel(s, id));

  /**
   * Phase 4 Tap-In: record the rider's check-in at their assigned pickup point (engine/tapIn.ts has the
   * approved check order). Arrival only: never boards, never changes the request, cart or stops.
   * A replay of an existing record returns it with alreadyRecorded: true and commits nothing, so it
   * creates no revision and no update; only the first successful Tap-In commits ride.tapped_in.
   */
  // errorHandler: malformed JSON on this route only is 400 INVALID_REQUEST (audit fix F1); other errors as app-wide.
  app.post<RideParams>("/api/ride-requests/:requestId/tap-in", { errorHandler: tapInErrorHandler }, async (req, reply) => {
    const body = TapInBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationErrorBody(body.error, "Tap-In (it takes exactly studentId, campusId and pointId)"));
    const id = req.params.requestId;
    const result = store.apply((s) => {
      const r = tapIn(s, id, body.data);
      return r.ok ? { ...r, request: r.state.requests.get(id)!, cart: r.state.fleet.carts.get(r.trip.cartId)! } : r;
    }, "ride.tapped_in");
    return sendResult(reply, result, (r) => ({ request: r.request, trip: r.trip, cart: r.cart, tapIn: r.tapIn, alreadyRecorded: r.alreadyRecorded }));
  });

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
    }, "simulation.advanced");
    return sendResult(reply, result, (r) => ({ clockSeconds: r.clockSeconds, carts: r.carts, trips: r.trips }));
  });

  // ---------- Driver arrival (explicit confirmation) ----------

  /**
   * The driver confirms arriving at the trip's current stop (engine confirmArrival). 409 when the cart is
   * not stopped there yet or arrival was already confirmed; 404 for an unknown trip. Records the time on
   * the stop only: boarding and drop-off remain separate driver actions.
   */
  app.post<{ Params: { tripId: string } }>("/api/trips/:tripId/arrive", async (req, reply) => {
    const body = EmptyActionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationErrorBody(body.error, "arrival call (it takes no fields)"));
    const id = req.params.tripId;
    const result = store.apply((s) => {
      const r = confirmArrival(s, id);
      return r.ok ? { ...r, cart: r.state.fleet.carts.get(r.trip.cartId)! } : r;
    }, "trip.arrived");
    return sendResult(reply, result, (r) => ({ trip: r.trip, cart: r.cart }));
  });

  // ---------- ETA (read-only) ----------

  /** The engine's ETA for a ride with a cart, plus how much of the current leg is driven. Never writes. */
  app.get<RideParams>("/api/ride-requests/:requestId/eta", async (req, reply) => {
    const id = req.params.requestId;
    const out = store.read((s, revision) => {
      const eta = rideEta(s, id);
      if (!eta.ok) return eta;
      const trip = tripForRequest(s, id);
      const cart = trip ? s.fleet.carts.get(trip.cartId) : undefined;
      let legProgress: number | null = null;
      if (trip?.leg && cart && trip.status === "active") {
        const total = routeDrivingSeconds(s.graph, trip.leg, cart.maxSpeedKmh);
        const left = legMetersLeft(s.graph, cart, trip.leg);
        if (total.ok && left.ok && total.meters > 0) legProgress = Math.min(1, Math.max(0, 1 - left.meters / total.meters));
      }
      return { ok: true as const, body: { requestId: id, revision, pickupSeconds: eta.pickupSeconds, destinationSeconds: eta.destinationSeconds, legProgress } };
    });
    if (!out.ok) {
      const { status, body } = rideErrorResponse(out.error);
      return reply.code(status).send(body);
    }
    return out.body;
  });

  // ---------- Mission Mode (read-only scenario comparison) ----------

  /**
   * Run Mission Mode (engine/mission.ts) on a private copy of the campus and the current fleet: pooling on
   * against pooling off on the same seeded demand. Never writes, never creates a revision.
   */
  app.post("/api/mission/run", async (req, reply) => {
    const body = MissionRunBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(validationErrorBody(body.error, "Mission Mode options"));
    const { campus, carts } = store.read((s) => ({ campus: s.campus, carts: listCarts(s.fleet) }));
    return runMission(campus, carts, body.data);
  });

  // ---------- Simulated movement (server-driven) ----------

  const TICK_MS = 1000;
  const auto = { running: false, speed: 1 as number, timer: null as ReturnType<typeof setInterval> | null };
  const tick = () => {
    try {
      const driving = store.read((s) => [...s.trips.values()].some((t) => t.status === "active" || t.status === "cancelling"));
      if (!driving) return; // nothing to move: no step, no revision
      store.apply((s) => advance(s, auto.speed), "simulation.advanced");
    } catch (err) {
      app.log.error({ err }, "simulated movement stopped after a failed step");
      setAuto(false);
    }
  };
  function setAuto(running: boolean, speed?: number) {
    if (speed !== undefined) auto.speed = speed;
    auto.running = running;
    if (running && !auto.timer) auto.timer = setInterval(tick, TICK_MS);
    if (!running && auto.timer) { clearInterval(auto.timer); auto.timer = null; }
  }
  app.addHook("onClose", async () => setAuto(false));
  const autoStatus = () => ({ running: auto.running, speed: auto.speed, tickMs: TICK_MS });
  app.get("/api/simulation/auto", async () => autoStatus());
  app.post("/api/simulation/auto", async (req, reply) => {
    const body = AutoAdvanceBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send(validationErrorBody(body.error, "simulated movement setting"));
    setAuto(body.data.running, body.data.speed);
    return autoStatus();
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
