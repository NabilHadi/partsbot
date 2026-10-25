import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("GET /health", () => {
  it("returns ok without a database configured", async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "not_configured" });
    await app.close();
  });

  it("reports 503 when the injected db fails", async () => {
    const db = { query: async () => Promise.reject(new Error("down")) } as never;
    const app = buildServer({ logger: false, db });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", db: "down" });
    await app.close();
  });

  it("reports db up when the injected db answers", async () => {
    const db = { query: async () => ({ rows: [] }) } as never;
    const app = buildServer({ logger: false, db });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ status: "ok", db: "up" });
    await app.close();
  });
});
