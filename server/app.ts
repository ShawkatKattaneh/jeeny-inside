import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CampusConfig } from "../shared/schemas.js";
import { PERSONAS } from "../shared/personas.js";
import { SETTINGS, INDEPENDENCE_NOTE } from "../shared/settings.js";

export interface AppOptions {
  campus: CampusConfig;
  /** Serve the built client from this folder (production / demo mode). */
  clientDir?: string;
  logger?: boolean;
}

/**
 * Phase 0 server: a few read-only REST endpoints and, in demo mode, the built web app.
 * Socket.IO, the tick loop and SQLite arrive with the phases that need them (1 and 2).
 */
export async function buildApp({ campus, clientDir, logger = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({ ok: true, campus: campus.id, time: Date.now() }));
  app.get("/api/campus", async () => campus);
  app.get("/api/personas", async () => PERSONAS);
  app.get("/api/about", async () => ({ note: INDEPENDENCE_NOTE, settings: SETTINGS }));

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
