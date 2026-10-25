import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "./db/pool.js";

export interface ServerDeps {
  /** Optional: when provided, /health also checks the database. Tests omit it. */
  db?: Db;
  /** Fastify logger option; pass false to silence in tests. */
  logger?: boolean;
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

  return app;
}
