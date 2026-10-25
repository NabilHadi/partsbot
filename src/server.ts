import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db/pool.js";
import { zernioWebhookRoutes, type ZernioWebhookDeps } from "./routes/zernio-webhook.js";

export interface ServerDeps {
  /** Optional: when provided, /health also checks the database. Tests omit it. */
  db?: Db;
  /** Fastify logger option; pass false to silence in tests. */
  logger?: boolean;
  /** When provided, mounts POST /webhooks/zernio. Omit to leave the route off. */
  zernio?: ZernioWebhookDeps;
}

/** App factory: builds the Fastify instance without listening, so tests can use inject(). */
export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  app.get("/health", async (_req, reply) => {
    if (!deps.db) return { status: "ok", db: "not_configured" };
    try {
      await deps.db.query("SELECT 1");
      return { status: "ok", db: "up" };
    } catch (err) {
      app.log.error({ err }, "health: database check failed");
      return reply.code(503).send({ status: "degraded", db: "down" });
    }
  });

  if (deps.zernio) void app.register(zernioWebhookRoutes(deps.zernio));

  return app;
}
