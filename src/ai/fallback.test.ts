import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAiFromConfig, type AiConfigLike } from "./index.js";
import { AiError, ChainProvider, type AiBackend, type AttemptEvent, type JsonRequest } from "./provider.js";
import { loadConfig } from "../config.js";
import { understandMessage } from "./understand.js";

const DS = "sk-ds-NEVER-LOGGED";
const OR = "sk-or-NEVER-LOGGED";
const base: AiConfigLike = { AI_ENABLED: true, AI_TIMEOUT_MS: 25000, AI_PROVIDER: "deepseek", GEMINI_MODEL: "gemini-3.1-flash-lite", GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite", DEEPSEEK_MODEL: "deepseek-flash", OPENROUTER_MODEL: "google/gemini-3.8-flash" };
const req: JsonRequest = { stage: "t", system: "s", user: "u", jsonSchema: { type: "object" } };

/** A backend that answers from a script, one entry per attempt. */
function scripted(name: string, script: (() => unknown)[]): AiBackend & { models: string[] } {
  const models: string[] = [];
  return {
    name,
    models,
    async attempt(model: string) {
      models.push(model);
      const next = script.shift();
      if (!next) throw new Error("no more");
      return { data: next(), usage: { inputTokens: 10, outputTokens: 2 } };
    },
    async checkModel(model: string) {
      return { ok: true, detail: `${name}:${model}` };
    },
  };
}

describe("primary + fallback provider from config", () => {
  it("AI_PROVIDER/AI_MODEL = primary, AI_FALLBACK_PROVIDER/AI_FALLBACK_MODEL = the one retry on another provider", () => {
    const s = createAiFromConfig({ ...base, AI_MODEL: "deepseek-flash", AI_FALLBACK_PROVIDER: "openrouter", AI_FALLBACK_MODEL: "google/gemini-3.5-flash-lite", DEEPSEEK_API_KEY: DS, OPENROUTER_API_KEY: OR });
    expect(s.enabled).toBe(true);
    expect(s.provider).toMatchObject({ name: "deepseek", model: "deepseek-flash", fallbackProvider: "openrouter", fallbackModel: "google/gemini-3.5-flash-lite" });
    expect(s.primary).toEqual({ provider: "deepseek", model: "deepseek-flash", keyConfigured: true });
    expect(s.fallback).toEqual({ provider: "openrouter", model: "google/gemini-3.5-flash-lite", keyConfigured: true });
    expect(s.warnings).toEqual([]);
    // A shop on aiProvider=openrouter: that IS the fallback provider, so its retry stays there (same model here).
    expect(s.byProvider.openrouter).toMatchObject({ model: "google/gemini-3.8-flash", fallbackProvider: null });
    expect(JSON.stringify([s.chains, s.primary, s.fallback])).not.toMatch(/NEVER-LOGGED/);
  });

  it("AI_FALLBACK_MODEL defaults to the fallback provider's own *_MODEL; AI_MODEL to the primary's", () => {
    const s = createAiFromConfig({ ...base, AI_FALLBACK_PROVIDER: "openrouter", DEEPSEEK_API_KEY: DS, OPENROUTER_API_KEY: OR });
    expect(s.primary.model).toBe("deepseek-flash");
    expect(s.fallback).toMatchObject({ provider: "openrouter", model: "google/gemini-3.8-flash" });
  });

  it("per-shop overrides keep working: a gemini shop also retries on the fallback provider", () => {
    const s = createAiFromConfig({ ...base, AI_FALLBACK_PROVIDER: "openrouter", DEEPSEEK_API_KEY: DS, OPENROUTER_API_KEY: OR, GEMINI_API_KEY: "g" });
    expect(s.byProvider.gemini).toMatchObject({ model: "gemini-3.1-flash-lite", fallbackProvider: "openrouter", fallbackModel: "google/gemini-3.8-flash" });
    expect(s.chains.map((c) => c.provider)).toEqual(["deepseek", "gemini", "openrouter"]);
  });

  it("fallback provider without a key: warning, retry stays on the primary provider", () => {
    const s = createAiFromConfig({ ...base, AI_FALLBACK_PROVIDER: "openrouter", DEEPSEEK_API_KEY: DS });
    expect(s.enabled).toBe(true);
    expect(s.provider).toMatchObject({ fallbackProvider: null, fallbackModel: null });
    expect(s.fallback).toMatchObject({ provider: "openrouter", keyConfigured: false });
    expect(s.warnings[0]).toMatch(/no API key/);
  });

  it("same provider as fallback with AI_FALLBACK_MODEL = same-provider retry on that model", () => {
    const s = createAiFromConfig({ ...base, AI_PROVIDER: "openrouter", AI_FALLBACK_PROVIDER: "openrouter", AI_FALLBACK_MODEL: "google/gemini-3.1-flash-lite", OPENROUTER_API_KEY: OR });
    expect(s.provider).toMatchObject({ name: "openrouter", model: "google/gemini-3.8-flash", fallbackProvider: null, fallbackModel: "google/gemini-3.1-flash-lite" });
  });

  it("config: deepseek is the code default; AI_MODEL / AI_FALLBACK_MODEL are provider-neutral (no longer Gemini aliases)", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x/y", AI_MODEL: "deepseek-flash", AI_FALLBACK_PROVIDER: "openrouter", AI_FALLBACK_MODEL: "google/gemini-3.8-flash" });
    expect(c.AI_PROVIDER).toBe("deepseek");
    expect(c.AI_MODEL).toBe("deepseek-flash");
    expect(c.AI_FALLBACK_MODEL).toBe("google/gemini-3.8-flash");
    expect(c.GEMINI_MODEL).toBe("gemini-3.8-flash");
    expect(loadConfig({ DATABASE_URL: "postgres://x/y" }).AI_MODEL).toBeNull();
  });
});

describe("ChainProvider fallback triggers", () => {
  const schema = z.object({ a: z.number() });
  for (const [label, first] of [
    ["timeout", () => { throw new AiError("timeout", ">25000ms"); }],
    ["HTTP error", () => { throw new AiError("http_error", "status=400"); }],
    ["no balance (402)", () => { throw new AiError("quota", "status=402"); }],
    ["bad JSON", () => { throw new AiError("bad_json", "x"); }],
    ["JSON that fails the stage schema", () => ({ a: "not a number" })],
  ] as const) {
    it(`primary ${label} -> the fallback provider answers`, async () => {
      const p = scripted("deepseek", [first]);
      const f = scripted("openrouter", [() => ({ a: 1 })]);
      const events: AttemptEvent[] = [];
      const chain = new ChainProvider([{ backend: p, model: "deepseek-flash" }, { backend: f, model: "google/gemini-3.8-flash" }], (e) => events.push(e));
      const r = await chain.generateJson({ ...req, accept: (d) => schema.safeParse(d).success });
      expect(r).toMatchObject({ data: { a: 1 }, provider: "openrouter", model: "google/gemini-3.8-flash", attempts: 2 });
      expect(events.map((e) => [e.provider, e.ok, e.final])).toEqual([["deepseek", false, false], ["openrouter", true, true]]);
    });
  }

  it("schema-invalid on both = schema_invalid error with both attempts' usage", async () => {
    const chain = new ChainProvider([{ backend: scripted("deepseek", [() => ({})]), model: "m1" }, { backend: scripted("openrouter", [() => ({})]), model: "m2" }]);
    const e = await chain.generateJson({ ...req, accept: () => false }).catch((x: unknown) => x);
    expect((e as AiError).reason).toBe("schema_invalid");
    expect((e as AiError).usage.inputTokens).toBe(20);
  });

  it("checkFallback checks the fallback step, null when the retry is the same model", async () => {
    const chain = new ChainProvider([{ backend: scripted("deepseek", []), model: "m1" }, { backend: scripted("openrouter", []), model: "m2" }]);
    expect(await chain.checkFallback()).toEqual({ ok: true, detail: "openrouter:m2" });
    const b = scripted("deepseek", []);
    expect(await new ChainProvider([{ backend: b, model: "m1" }, { backend: b, model: "m1" }]).checkFallback()).toBeNull();
  });

  it("understand: a primary answer that fails the understanding schema is retried on the fallback", async () => {
    const good = { intent: "part_request", vin_or_frame: null, parts: [{ customer_words: "فلتر زيت", normalized_en: "oil filter", normalized_ar: "فلتر زيت", position: null, qty: null }], clarification_needed: false, language: "ar" };
    const p = scripted("deepseek", [() => ({ intent: "nonsense" })]);
    const f = scripted("openrouter", [() => good]);
    const chain = new ChainProvider([{ backend: p, model: "deepseek-flash" }, { backend: f, model: "google/gemini-3.8-flash" }]);
    const r = await understandMessage(chain, { text: "ابي فلتر زيت", history: [], vehicle: null, language: "auto", waitingFor: null, lastPart: null });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("google/gemini-3.8-flash");
  });
});
