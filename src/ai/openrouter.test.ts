import { describe, expect, it } from "vitest";
import { OpenRouterBackend, OpenRouterProvider } from "./openrouter.js";
import { AiError, ChainProvider, costUsd, type AttemptEvent } from "./provider.js";
import { createAiFromConfig } from "./index.js";
import { loadConfig } from "../config.js";
import { shopConfigSchema } from "../bot/shop-config.js";

const KEY = "sk-or-v1-test-NEVER-LOGGED";
const MODEL = "google/gemini-3.8-flash";
const ok = (obj: unknown, usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 }, cost: 0.000123 }) =>
  new Response(JSON.stringify({ id: "gen-1", choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }], usage }), { status: 200 });
const err = (status: number) => new Response(JSON.stringify({ error: { code: status, message: "x" } }), { status });
const req = { stage: "understand", system: "sys", user: "hello", jsonSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const bodyOf = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as Record<string, any>;
const headersOf = (c: { init: RequestInit }) => c.init.headers as Record<string, string>;

describe("OpenRouterProvider", () => {
  it("chat/completions with bearer key, attribution headers, json_schema structured output, usage.include and low reasoning", async () => {
    const { f, calls } = fakeFetch([() => ok({ a: 1 })]);
    const p = new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f });
    const r = await p.generateJson({ ...req, temperature: 0.1 });
    expect(r.data).toEqual({ a: 1 });
    expect(r.provider).toBe("openrouter");
    expect(r.model).toBe(MODEL);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, costUsd: 0.000123 });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.url).not.toContain(KEY);
    const h = headersOf(calls[0]!);
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    expect(h["X-Title"]).toBe("PartsBot");
    expect(h["HTTP-Referer"]).toMatch(/^https:\/\//);
    const b = bodyOf(calls[0]!);
    expect(b.model).toBe(MODEL);
    expect(b.response_format).toEqual({ type: "json_schema", json_schema: { name: "partsbot_understand", strict: true, schema: req.jsonSchema } });
    expect(b.usage).toEqual({ include: true });
    expect(b.reasoning).toEqual({ effort: "low", exclude: true });
    expect(b.provider).toEqual({ require_parameters: true });
    expect(b.temperature).toBe(0.1);
    expect(b.stream).toBe(false);
    expect(b.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "hello" }]);
  });

  it("json_object mode puts the schema in the system prompt; reasoning none disables thinking", async () => {
    const { f, calls } = fakeFetch([() => ok({ a: 1 })]);
    await new OpenRouterProvider({ apiKey: KEY, model: MODEL, jsonMode: "json_object", reasoning: "none", fetchImpl: f }).generateJson(req);
    const b = bodyOf(calls[0]!);
    expect(b.response_format).toEqual({ type: "json_object" });
    expect(b.messages[0].content).toContain('"properties"');
    expect(b.reasoning).toEqual({ enabled: false, exclude: true });
  });

  it("accepts JSON wrapped in a markdown fence", async () => {
    const fenced = () => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"a":5}\n```' }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    const { f } = fakeFetch([fenced]);
    expect((await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f }).generateJson(req)).data).toEqual({ a: 5 });
  });

  it("retries once on 429 / 502 / 503 / empty / bad JSON; never retries 402 (no credits) or 401 on the same model", async () => {
    const blank = () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { cost: 0.00001 } }), { status: 200 });
    const bad = () => new Response(JSON.stringify({ choices: [{ message: { content: "{nope" }, finish_reason: "length" }], usage: {} }), { status: 200 });
    for (const first of [() => err(429), () => err(502), () => err(503), blank, bad]) {
      const { f, calls } = fakeFetch([first, () => ok({ a: 2 })]);
      const r = await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f }).generateJson(req);
      expect(r.data).toEqual({ a: 2 });
      expect(r.attempts).toBe(2);
      expect(calls).toHaveLength(2);
    }
    for (const [status, reason] of [[402, "quota"], [401, "auth"]] as const) {
      const { f, calls } = fakeFetch([() => err(status), () => ok({ a: 2 })]);
      const e = await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f }).generateJson(req).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AiError);
      expect((e as AiError).reason).toBe(reason);
      expect(calls).toHaveLength(1);
      expect(String(e) + JSON.stringify(e)).not.toContain(KEY);
    }
  });

  it("retry costs add up; a 200 with an upstream error in the body is an error, not an answer", async () => {
    const upstream = () => new Response(JSON.stringify({ error: { code: 502, message: "provider down SECRETTEXT" }, usage: { cost: 0.0001 } }), { status: 200 });
    const { f } = fakeFetch([upstream, () => ok({ a: 3 }, { prompt_tokens: 10, completion_tokens: 2, cost: 0.0002 })]);
    const r = await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f }).generateJson(req);
    expect(r.attempts).toBe(2);
    expect(r.usage.costUsd).toBeCloseTo(0.0003);
    const { f: f2 } = fakeFetch([upstream, upstream]);
    const e = await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f2 }).generateJson(req).catch((x: unknown) => x);
    expect((e as AiError).reason).toBe("overloaded");
    expect((e as AiError).detail).not.toContain("SECRETTEXT");
  });

  it("uses OPENROUTER_FALLBACK_MODEL for the retry and reports every attempt to the observer", async () => {
    const { f, calls } = fakeFetch([() => err(429), () => ok({ a: 4 })]);
    const events: AttemptEvent[] = [];
    const p = new OpenRouterProvider({ apiKey: KEY, model: MODEL, fallbackModel: "google/gemini-3.1-flash-lite", fetchImpl: f, observer: (e) => events.push(e) });
    const r = await p.generateJson(req);
    expect(r.model).toBe("google/gemini-3.1-flash-lite");
    expect(bodyOf(calls[1]!).model).toBe("google/gemini-3.1-flash-lite");
    expect(events.map((e) => [e.provider, e.model, e.ok, e.reason, e.final])).toEqual([
      ["openrouter", MODEL, false, "rate_limited", false],
      ["openrouter", "google/gemini-3.1-flash-lite", true, null, true],
    ]);
  });

  it("times out after timeoutMs", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const e = await new OpenRouterProvider({ apiKey: KEY, model: MODEL, timeoutMs: 20, fetchImpl: f }).generateJson(req).catch((x: unknown) => x);
    expect((e as AiError).reason).toBe("timeout");
  });

  it("check(): key via GET /key, model via GET /models; never echoes the key", async () => {
    const { f, calls } = fakeFetch([() => new Response(JSON.stringify({ data: { label: "x" } }), { status: 200 }), () => new Response(JSON.stringify({ data: [{ id: MODEL }] }), { status: 200 })]);
    const c = await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f }).check();
    expect(c).toEqual({ ok: true, detail: "model available, key accepted" });
    expect(calls.map((x) => x.url)).toEqual(["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/models"]);
    const { f: f2 } = fakeFetch([() => err(401)]);
    const c2 = await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f2 }).check();
    expect(c2.ok).toBe(false);
    expect(c2.detail).not.toContain(KEY);
    const { f: f3 } = fakeFetch([() => new Response("{}", { status: 200 }), () => new Response(JSON.stringify({ data: [{ id: "other" }] }), { status: 200 })]);
    expect((await new OpenRouterProvider({ apiKey: KEY, model: MODEL, fetchImpl: f3 }).check()).ok).toBe(false);
  });

  it("can be the cross-provider retry target of another chain", async () => {
    const a = fakeFetch([() => err(402)]);
    const b = fakeFetch([() => ok({ a: 6 })]);
    const chain = new ChainProvider([{ backend: new OpenRouterBackend({ apiKey: KEY, fetchImpl: a.f }), model: MODEL }, { backend: new OpenRouterBackend({ apiKey: KEY, fetchImpl: b.f }), model: "google/gemini-3.1-flash-lite" }]);
    expect((await chain.generateJson(req)).data).toEqual({ a: 6 });
  });
});

describe("OpenRouter config and selection", () => {
  it("config: AI_PROVIDER=openrouter, defaults, and AI_FALLBACK_PROVIDER=openrouter parse", () => {
    const c = loadConfig({ DATABASE_URL: "postgres://x/y", AI_PROVIDER: "openrouter", AI_FALLBACK_PROVIDER: "openrouter", OPENROUTER_API_KEY: KEY });
    expect(c.AI_PROVIDER).toBe("openrouter");
    expect(c.AI_FALLBACK_PROVIDER).toBe("openrouter");
    expect(c.OPENROUTER_MODEL).toBe(MODEL);
    expect(c.OPENROUTER_REASONING).toBe("low");
    expect(c.OPENROUTER_JSON_MODE).toBe("json_schema");
    expect(c.OPENROUTER_FALLBACK_MODEL).toBeNull();
  });

  it("createAiFromConfig builds an openrouter chain per key; shops can pick aiProvider=openrouter", () => {
    const base = { AI_ENABLED: true, AI_TIMEOUT_MS: 25000, GEMINI_MODEL: "gemini-3.1-flash-lite", DEEPSEEK_MODEL: "deepseek-flash" };
    const s = createAiFromConfig({ ...base, AI_PROVIDER: "gemini", GEMINI_API_KEY: "g", OPENROUTER_API_KEY: KEY, OPENROUTER_MODEL: MODEL });
    expect(s.enabled).toBe(true);
    expect(s.byProvider.openrouter!.name).toBe("openrouter");
    expect(s.byProvider.openrouter!.model).toBe(MODEL);
    expect(s.chains.map((c) => c.provider)).toEqual(["gemini", "openrouter"]);
    expect(JSON.stringify(s.chains)).not.toContain(KEY);
    const o = createAiFromConfig({ ...base, AI_PROVIDER: "openrouter", AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "g", OPENROUTER_API_KEY: KEY });
    expect(o.enabled && o.provider.name).toBe("openrouter");
    expect(o.provider!.fallbackProvider).toBe("gemini");
    const n = createAiFromConfig({ ...base, AI_PROVIDER: "openrouter", GEMINI_API_KEY: "g" });
    expect(!n.enabled && n.reason).toBe("no_key");
    expect(n.chains[0]).toMatchObject({ provider: "openrouter", model: MODEL, keyConfigured: false });
    expect(shopConfigSchema.parse({ aiProvider: "openrouter" }).aiProvider).toBe("openrouter");
  });

  it("costUsd prefers the cost OpenRouter reported, else the price table", () => {
    expect(costUsd(MODEL, { inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.42 })).toBe(0.42);
    expect(costUsd(MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(4.95);
  });
});
