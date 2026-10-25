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
});
