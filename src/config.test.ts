import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("parses a valid env and applies defaults", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://x", ONEEPC_API_KEY: "k" });
    expect(cfg.PORT).toBe(3000);
    expect(cfg.ONEEPC_BASE_URL).toContain("/api/bot/v1");
  });

  it("throws a readable error when required vars are missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("keeps Zernio settings optional and enforces a minimum webhook secret length", () => {
    const base = { DATABASE_URL: "postgres://x", ONEEPC_API_KEY: "k" };
    expect(loadConfig(base).ZERNIO_WEBHOOK_SECRET).toBeUndefined();
    expect(loadConfig({ ...base, ZERNIO_WEBHOOK_SECRET: "0123456789abcdef" }).ZERNIO_WEBHOOK_SECRET).toBe("0123456789abcdef");
    expect(() => loadConfig({ ...base, ZERNIO_WEBHOOK_SECRET: "short" })).toThrow(/ZERNIO_WEBHOOK_SECRET/);
  });

  it("ALLOW_SYNTHETIC_STOCK is on only for the exact string 'true'", () => {
    const base = { DATABASE_URL: "postgres://x", ONEEPC_API_KEY: "k" };
    expect(loadConfig(base).ALLOW_SYNTHETIC_STOCK).toBe(false);
    expect(loadConfig({ ...base, ALLOW_SYNTHETIC_STOCK: "true" }).ALLOW_SYNTHETIC_STOCK).toBe(true);
    expect(loadConfig({ ...base, ALLOW_SYNTHETIC_STOCK: "1" }).ALLOW_SYNTHETIC_STOCK).toBe(false);
  });
});
