/**
 * DeepSeek over its OpenAI-compatible REST API (https://api-docs.deepseek.com), no SDK:
 *   POST {base}/chat/completions  with response_format={type:"json_object"} (JSON Output mode).
 * JSON mode does not take a schema, so the schema goes into the system prompt (the docs also require the word "json"
 * and an example there); callers still validate the result with the same zod schemas.
 * Thinking is disabled by default: it adds latency, and temperature only works in non-thinking mode.
 * The key goes in the Authorization header; errors carry only a reason code (never the key or the response body).
 */
import { AiError, ChainProvider, type AiBackend, type AiProvider, type AiUsage, type AttemptObserver, type JsonRequest, type JsonResult } from "./provider.js";

export interface DeepSeekOptions {
  apiKey: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** null/"disabled" = non-thinking mode (default). "low"/"high" = thinking with that effort. */
  thinking?: "disabled" | "low" | "high" | null;
  fetchImpl?: typeof fetch;
}

export const DEEPSEEK_DEFAULT_BASE = "https://api.deepseek.com";

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

/** Appended to the system prompt: JSON Output mode needs the format spelled out. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return `\n\nOutput format: reply with ONE json object only (no markdown, no prose) that matches this JSON Schema exactly. Use null for unknown values where the schema allows it; include every required key.\n${JSON.stringify(schema)}`;
}

export class DeepSeekBackend implements AiBackend {
  readonly name = "deepseek";
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly base: string;
  private readonly thinking: DeepSeekOptions["thinking"];
  private readonly fetchImpl: typeof fetch;

  constructor(o: DeepSeekOptions) {
    this.key = o.apiKey;
    this.timeoutMs = o.timeoutMs ?? 25000;
    this.base = (o.baseUrl ?? DEEPSEEK_DEFAULT_BASE).replace(/\/$/, "");
    this.thinking = o.thinking ?? "disabled";
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async attempt(model: string, req: JsonRequest): Promise<{ data: unknown; usage: AiUsage }> {
    const thinkingOn = this.thinking === "low" || this.thinking === "high";
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: req.system + schemaInstruction(req.jsonSchema) },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_object" },
      max_tokens: req.maxOutputTokens ?? 1024,
      stream: false,
      thinking: { type: thinkingOn ? "enabled" : "disabled" },
      ...(thinkingOn ? { reasoning_effort: this.thinking } : { temperature: req.temperature ?? 0.1 }),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    let json: ChatResponse;
    try {
      res = await this.fetchImpl(`${this.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      try {
        json = (await res.json()) as ChatResponse;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        throw new AiError(res.status === 503 ? "overloaded" : "http_error", `status=${res.status} non_json`);
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      if ((err as Error)?.name === "AbortError") throw new AiError("timeout", `>${this.timeoutMs}ms`);
      throw new AiError("network", (err as Error)?.name ?? "fetch_failed");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // DeepSeek: 402 = insufficient balance, 429 = rate limit, 500/503 = server busy. Status only.
      const reason =
        res.status === 402 ? "quota" : res.status === 429 ? "rate_limited" : res.status === 500 || res.status === 503 ? "overloaded" : res.status === 401 || res.status === 403 ? "auth" : "http_error";
      throw new AiError(reason, `status=${res.status}`);
    }
    const u = json.usage ?? {};
    const usage: AiUsage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cachedInputTokens: u.prompt_cache_hit_tokens ?? 0 };
    const choice = json.choices?.[0];
    const text = (choice?.message?.content ?? "").trim();
    if (choice?.finish_reason === "content_filter") throw new AiError("blocked", "finish=content_filter", usage);
    // JSON mode replaces non-JSON output with spaces, so an "empty" answer is a failed JSON answer (retryable).
    if (!text) throw new AiError("empty", `finish=${choice?.finish_reason ?? "none"}`, usage);
    try {
      return { data: JSON.parse(text), usage };
    } catch {
      throw new AiError("bad_json", `finish=${choice?.finish_reason ?? "none"} length=${text.length}`, usage);
    }
  }

  /** GET /models: is the model listed for this key? Never throws. */
  async checkModel(model: string): Promise<{ ok: boolean; detail: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await this.fetchImpl(`${this.base}/models`, { headers: { authorization: `Bearer ${this.key}` }, signal: ctrl.signal });
      if (res.status === 401 || res.status === 403) return { ok: false, detail: `key rejected (HTTP ${res.status})` };
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const j = (await res.json()) as { data?: { id?: string }[] };
      const ids = (j.data ?? []).map((m) => m.id);
      // Legacy aliases (deepseek-v4-flash) are accepted by the API but no longer listed.
      return ids.includes(model) ? { ok: true, detail: "model available, key accepted" } : { ok: true, detail: "key accepted; model not listed by GET /models (legacy alias?)" };
    } catch (err) {
      return { ok: false, detail: (err as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** DeepSeek on its own (retry on DEEPSEEK_FALLBACK_MODEL or the same model). */
export class DeepSeekProvider implements AiProvider {
  readonly name = "deepseek";
  readonly model: string;
  readonly fallbackModel: string | null;
  readonly fallbackProvider = null;
  readonly backend: DeepSeekBackend;
  private readonly chain: ChainProvider;

  constructor(o: DeepSeekOptions & { model: string; fallbackModel?: string | null; observer?: AttemptObserver }) {
    this.model = o.model;
    this.fallbackModel = o.fallbackModel ?? null;
    this.backend = new DeepSeekBackend(o);
    this.chain = new ChainProvider([{ backend: this.backend, model: o.model }, { backend: this.backend, model: o.fallbackModel ?? o.model }], o.observer);
  }

  generateJson(req: JsonRequest): Promise<JsonResult> {
    return this.chain.generateJson(req);
  }

  check(): Promise<{ ok: boolean; detail: string }> {
    return this.backend.checkModel(this.model);
  }
}
