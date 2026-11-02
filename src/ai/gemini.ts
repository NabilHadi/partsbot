/**
 * Gemini (Google AI Studio / Developer API) over plain REST, no SDK:
 *   POST {base}/models/{model}:generateContent  with responseMimeType=application/json + responseJsonSchema.
 * The key goes in the x-goog-api-key header (never in the URL, so it cannot end up in an access log).
 * Timeout per attempt, ONE retry on transient failures (optionally on AI_FALLBACK_MODEL).
 */
import { AiError, type AiProvider, type AiUsage, type JsonRequest, type JsonResult } from "./provider.js";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fallbackModel?: string | null;
  timeoutMs?: number;
  baseUrl?: string;
  /** "low" keeps chat latency down; Gemini 3.8 Flash does not accept "minimal". */
  thinkingLevel?: "low" | "medium" | "high" | null;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly fallbackModel: string | null;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly base: string;
  private readonly thinkingLevel: GeminiOptions["thinkingLevel"];
  private readonly fetchImpl: typeof fetch;

  constructor(o: GeminiOptions) {
    this.key = o.apiKey;
    this.model = o.model;
    this.fallbackModel = o.fallbackModel ?? null;
    this.timeoutMs = o.timeoutMs ?? 25000;
    this.base = (o.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.thinkingLevel = o.thinkingLevel === undefined ? "low" : o.thinkingLevel;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async generateJson(req: JsonRequest): Promise<JsonResult> {
    const started = Date.now();
    const total: AiUsage = { inputTokens: 0, outputTokens: 0 };
    let lastErr: AiError | null = null;
    const models = [this.model, this.fallbackModel ?? this.model];
    for (let attempt = 0; attempt < 2; attempt++) {
      const model = models[attempt]!;
      try {
        const r = await this.once(model, req);
        total.inputTokens += r.usage.inputTokens;
        total.outputTokens += r.usage.outputTokens;
        return { data: r.data, usage: total, latencyMs: Date.now() - started, model, attempts: attempt + 1 };
      } catch (err) {
        const e = err instanceof AiError ? err : new AiError("network", (err as Error)?.name ?? "unknown");
        total.inputTokens += e.usage.inputTokens;
        total.outputTokens += e.usage.outputTokens;
        lastErr = e;
        if (!e.retryable) break;
      }
    }
    throw new AiError(lastErr!.reason, lastErr!.detail, total, Date.now() - started);
  }

  private thinkingConfig(model: string): Record<string, unknown> | undefined {
    if (!this.thinkingLevel) return undefined;
    // thinkingLevel is a Gemini 3+ parameter; 2.x models use thinkingBudget instead.
    if (/^gemini-2\./.test(model)) return { thinkingBudget: 0 };
    return { thinkingLevel: this.thinkingLevel };
  }

  private async once(model: string, req: JsonRequest): Promise<{ data: unknown; usage: AiUsage }> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.1,
        maxOutputTokens: req.maxOutputTokens ?? 1024,
        responseMimeType: "application/json",
        responseJsonSchema: req.jsonSchema,
        ...(this.thinkingConfig(model) ? { thinkingConfig: this.thinkingConfig(model) } : {}),
      },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") throw new AiError("timeout", `>${this.timeoutMs}ms`);
      throw new AiError("network", (err as Error)?.name ?? "fetch_failed");
    }
    let json: GeminiResponse;
    try {
      json = (await res.json()) as GeminiResponse;
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") throw new AiError("timeout", `>${this.timeoutMs}ms`);
      throw new AiError("http_error", `status=${res.status} non_json`);
    }
    clearTimeout(timer);
    if (!res.ok) {
      // Only the status: the error body can echo request details.
      const reason = res.status === 429 ? "rate_limited" : res.status === 503 ? "overloaded" : res.status === 401 || res.status === 403 ? "auth" : "http_error";
      throw new AiError(reason, `status=${res.status}`);
    }
    const um = json.usageMetadata ?? {};
    const usage: AiUsage = {
      inputTokens: um.promptTokenCount ?? 0,
      outputTokens: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
    };
    if (json.promptFeedback?.blockReason) throw new AiError("blocked", `prompt:${json.promptFeedback.blockReason}`, usage);
    const cand = json.candidates?.[0];
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
    if (!text) throw new AiError(cand?.finishReason === "SAFETY" ? "blocked" : "empty", `finish=${cand?.finishReason ?? "none"}`, usage);
    try {
      return { data: JSON.parse(text), usage };
    } catch {
      throw new AiError("bad_json", `finish=${cand?.finishReason ?? "none"} length=${text.length}`, usage);
    }
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await this.fetchImpl(`${this.base}/models/${encodeURIComponent(this.model)}`, {
        headers: { "x-goog-api-key": this.key },
        signal: ctrl.signal,
      });
      if (res.ok) return { ok: true, detail: "model available, key accepted" };
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `key rejected (HTTP ${res.status})` };
      if (res.status === 404) return { ok: false, detail: "model id not found (HTTP 404)" };
      return { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
