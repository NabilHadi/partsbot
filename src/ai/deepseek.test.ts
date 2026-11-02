import { describe, expect, it } from "vitest";
import { DeepSeekProvider } from "./deepseek.js";
import { GeminiBackend } from "./gemini.js";
import { DeepSeekBackend } from "./deepseek.js";
import { AiError, ChainProvider, costUsd, type AttemptEvent } from "./provider.js";
import { createAiFromConfig } from "./index.js";

const KEY = "sk-test-deepseek-NEVER-LOGGED";
const GKEY = "test-gemini-key-NEVER-LOGGED";
const ok = (obj: unknown, usage = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64 }) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }], usage }), { status: 200 });
const err = (status: number) => new Response(JSON.stringify({ error: { message: "x" } }), { status });
const gOk = (obj: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
const req = { stage: "t", system: "sys", user: "hello", jsonSchema: { type: "object", properties: { a: { type: "number" } } } };

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
const bodyOf = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as Record<string, unknown> & { messages: { role: string; content: string }[] };

describe("DeepSeekProvider", () => {
  it("OpenAI-compatible call: bearer key in a header, JSON output mode, schema in the system prompt, thinking off", async () => {
    const { f, calls } = fakeFetch([() => ok({ a: 1 })]);
    const p = new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", fetchImpl: f });
    const r = await p.generateJson({ ...req, temperature: 0.1 });
    expect(r.data).toEqual({ a: 1 });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 64 });
    expect(r.provider).toBe("deepseek");
    expect(calls[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0]!.url).not.toContain(KEY);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const b = bodyOf(calls[0]!);
    expect(b.model).toBe("deepseek-flash");
    expect(b.response_format).toEqual({ type: "json_object" });
    expect(b.thinking).toEqual({ type: "disabled" });
    expect(b.temperature).toBe(0.1);
    expect(b.messages[0]!.role).toBe("system");
    expect(b.messages[0]!.content).toContain("sys");
    expect(b.messages[0]!.content.toLowerCase()).toContain("json");
    expect(b.messages[0]!.content).toContain('"properties"');
    expect(b.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("thinking mode sends reasoning_effort and no temperature", async () => {
    const { f, calls } = fakeFetch([() => ok({ a: 1 })]);
    const p = new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", thinking: "high", fetchImpl: f });
    await p.generateJson({ ...req, temperature: 0.1 });
    const b = bodyOf(calls[0]!);
    expect(b.thinking).toEqual({ type: "enabled" });
    expect(b.reasoning_effort).toBe("high");
    expect(b.temperature).toBeUndefined();
  });

  it("retries once on 429 / 503 / empty content; never retries 402 (no balance) on the same model", async () => {
    const blank = () => new Response(JSON.stringify({ choices: [{ message: { content: "  \n " }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    for (const first of [() => err(429), () => err(503), blank]) {
      const { f, calls } = fakeFetch([first, () => ok({ a: 2 })]);
      const p = new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", fetchImpl: f });
      const r = await p.generateJson(req);
      expect(r.data).toEqual({ a: 2 });
      expect(r.attempts).toBe(2);
      expect(calls).toHaveLength(2);
    }
    const { f, calls } = fakeFetch([() => err(402), () => ok({ a: 2 })]);
    const p = new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", fetchImpl: f });
    const e = await p.generateJson(req).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiError);
    expect((e as AiError).reason).toBe("quota");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(e) + String(e)).not.toContain(KEY);
  });

  it("maps 401 to auth and bad JSON to bad_json, without the key or the text in the error", async () => {
    const { f } = fakeFetch([() => err(401)]);
    const e = await new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", fetchImpl: f }).generateJson(req).catch((x: unknown) => x);
    expect((e as AiError).reason).toBe("auth");
    const bad = () => new Response(JSON.stringify({ choices: [{ message: { content: "{not json SECRETTEXT" }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    const { f: f2 } = fakeFetch([bad, bad]);
    const e2 = await new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", fetchImpl: f2 }).generateJson(req).catch((x: unknown) => x);
    expect((e2 as AiError).reason).toBe("bad_json");
    expect(String((e2 as AiError).detail)).not.toContain("SECRETTEXT");
  });

  it("times out", async () => {
    const f = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const e = await new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", timeoutMs: 20, fetchImpl: f }).generateJson(req).catch((x: unknown) => x);
    expect((e as AiError).reason).toBe("timeout");
  });

  it("check() lists models with the key and finds the model", async () => {
    const { f, calls } = fakeFetch([() => new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }), { status: 200 })]);
    const c = await new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", fetchImpl: f }).check();
    expect(c.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://api.deepseek.com/models");
    expect(c.detail).not.toContain(KEY);
    const { f: f2 } = fakeFetch([() => err(401)]);
    expect((await new DeepSeekProvider({ apiKey: KEY, model: "deepseek-flash", fetchImpl: f2 }).check()).ok).toBe(false);
  });
});

describe("cross-provider chain", () => {
  it("DeepSeek first; on quota/timeout the one retry goes to Gemini; observer sees both attempts", async () => {
    const ds = fakeFetch([() => err(402)]);
    const gm = fakeFetch([() => gOk({ a: 3 })]);
    const events: AttemptEvent[] = [];
    const chain = new ChainProvider(
      [{ backend: new DeepSeekBackend({ apiKey: KEY, fetchImpl: ds.f }), model: "deepseek-flash" }, { backend: new GeminiBackend({ apiKey: GKEY, fetchImpl: gm.f }), model: "gemini-3.1-flash-lite" }],
      (e) => events.push(e),
    );
    expect(chain.fallbackProvider).toBe("gemini");
    const r = await chain.generateJson(req);
    expect(r.data).toEqual({ a: 3 });
    expect(r.model).toBe("gemini-3.1-flash-lite");
    expect(r.provider).toBe("gemini");
    expect(events.map((e) => [e.provider, e.ok, e.reason, e.final])).toEqual([["deepseek", false, "quota", false], ["gemini", true, null, true]]);
    expect(events[0]!.callId).toBe(events[1]!.callId);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("createAiFromConfig: per-provider chains, AI_FALLBACK_PROVIDER, no_key", () => {
    const base = { AI_ENABLED: true, AI_TIMEOUT_MS: 25000, GEMINI_MODEL: "gemini-3.1-flash-lite", GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite", DEEPSEEK_MODEL: "deepseek-flash" };
    const s = createAiFromConfig({ ...base, AI_PROVIDER: "deepseek", AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: GKEY, DEEPSEEK_API_KEY: KEY });
    expect(s.enabled).toBe(true);
    expect(s.provider!.name).toBe("deepseek");
    expect(s.provider!.fallbackModel).toBe("gemini-3.1-flash-lite");
    expect(s.byProvider.gemini!.fallbackModel).toBe("gemini-3.5-flash-lite");
    expect(s.chains.map((c) => c.provider)).toEqual(["deepseek", "gemini"]);
    expect(JSON.stringify(s.chains)).not.toContain(KEY);
    const g = createAiFromConfig({ ...base, AI_PROVIDER: "gemini", GEMINI_API_KEY: GKEY });
    expect(g.enabled && g.provider.name).toBe("gemini");
    expect(g.byProvider.deepseek).toBeUndefined();
    const n = createAiFromConfig({ ...base, AI_PROVIDER: "deepseek", GEMINI_API_KEY: GKEY });
    expect(n.enabled).toBe(false);
    expect(!n.enabled && n.reason).toBe("no_key");
  });
});

describe("costUsd", () => {
  it("prices DeepSeek cache hits low and halves off-peak", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 };
    expect(costUsd("deepseek-flash", u)).toBeCloseTo(1.5);
    expect(costUsd("deepseek-flash", { ...u, cachedInputTokens: 1_000_000 })).toBeCloseTo(1.206);
    expect(costUsd("deepseek-flash", u, new Date("2026-11-02T07:00:00Z"))).toBeCloseTo(1.5); // Monday 10:00 Riyadh: peak
    expect(costUsd("deepseek-flash", u, new Date("2026-11-01T07:00:00Z"))).toBeCloseTo(0.75); // Sunday: off-peak
    expect(costUsd("gemini-3.1-flash-lite", u, new Date("2026-11-01T07:00:00Z"))).toBeCloseTo(1.75);
  });
});
