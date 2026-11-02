import { describe, expect, it } from "vitest";
import { GeminiProvider } from "./gemini.js";
import { AiError } from "./provider.js";

const KEY = "test-gemini-key-NEVER-LOGGED";
const ok = (obj: unknown, usage = { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 }) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }], usageMetadata: usage }), { status: 200 });
const req = { stage: "t", system: "sys", user: "hello", jsonSchema: { type: "object" } };

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

describe("GeminiProvider", () => {
  it("sends the key in a header (never the URL), JSON schema output, low temperature; parses usage", async () => {
    const { f, calls } = fakeFetch([() => ok({ a: 1 })]);
    const p = new GeminiProvider({ apiKey: KEY, model: "gemini-3.8-flash", fetchImpl: f });
    const r = await p.generateJson({ ...req, temperature: 0.1 });
    expect(r.data).toEqual({ a: 1 });
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 15 });
    expect(r.attempts).toBe(1);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(calls[0]!.url).not.toContain(KEY);
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig).toMatchObject({ temperature: 0.1, responseMimeType: "application/json", responseJsonSchema: { type: "object" }, thinkingConfig: { thinkingLevel: "low" } });
  });

  it("retries once on 503, on the fallback model when set", async () => {
    const { f, calls } = fakeFetch([() => new Response("{}", { status: 503 }), () => ok({ b: 2 })]);
    const p = new GeminiProvider({ apiKey: KEY, model: "m1", fallbackModel: "gemini-2.5-flash", fetchImpl: f });
    const r = await p.generateJson(req);
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.attempts).toBe(2);
    expect(calls[1]!.url).toContain("/models/gemini-2.5-flash:generateContent");
    expect(JSON.parse(String(calls[1]!.init.body)).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("does not retry auth errors; errors never contain the key or the response body", async () => {
    const { f, calls } = fakeFetch([() => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 403 })]);
    const p = new GeminiProvider({ apiKey: KEY, model: "m1", fetchImpl: f });
    const err = (await p.generateJson(req).catch((e) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.reason).toBe("auth");
    expect(calls).toHaveLength(1);
    expect(String(err.message)).not.toContain(KEY);
  });

  it("times out, retries once, then reports timeout", async () => {
    const hang = () => new Promise<Response>(() => undefined);
    const f = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    void hang;
    const p = new GeminiProvider({ apiKey: KEY, model: "m1", timeoutMs: 20, fetchImpl: f });
    const err = (await p.generateJson(req).catch((e) => e)) as AiError;
    expect(err.reason).toBe("timeout");
  });

  it("non-JSON text, empty candidates and blocked prompts are typed errors", async () => {
    const bad = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 });
    let p = new GeminiProvider({ apiKey: KEY, model: "m", fetchImpl: fakeFetch([bad, bad]).f });
    expect(((await p.generateJson(req).catch((e) => e)) as AiError).reason).toBe("bad_json");
    const blocked = () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 });
    p = new GeminiProvider({ apiKey: KEY, model: "m", fetchImpl: fakeFetch([blocked]).f });
    expect(((await p.generateJson(req).catch((e) => e)) as AiError).reason).toBe("blocked");
  });

  it("check(): ok / key rejected / model missing, never throws", async () => {
    const mk = (status: number) => new GeminiProvider({ apiKey: KEY, model: "m", fetchImpl: fakeFetch([() => new Response("{}", { status })]).f });
    expect(await mk(200).check()).toEqual({ ok: true, detail: "model available, key accepted" });
    expect((await mk(403).check()).detail).toContain("key rejected");
    expect((await mk(404).check()).detail).toContain("not found");
    const down = new GeminiProvider({ apiKey: KEY, model: "m", fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect(await down.check()).toEqual({ ok: false, detail: "unreachable" });
  });
});
