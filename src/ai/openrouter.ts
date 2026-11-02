/**
 * OpenRouter (https://openrouter.ai/docs) over its OpenAI-compatible REST API, no SDK:
 *   POST {base}/chat/completions  with response_format={type:"json_schema"} (structured outputs) and usage={include:true}.
 * One key reaches many models (e.g. google/gemini-3.8-flash) without the Gemini free-tier daily cap.
 * `provider.require_parameters` makes OpenRouter route only to endpoints that honour response_format.
 * The billed cost per call comes back in usage.cost and is passed on as AiUsage.costUsd.
 * The key goes in the Authorization header; errors carry only a reason code (never the key or the response body).
 */
import { schemaInstruction } from "./deepseek.js";
import { AiError, ChainProvider, type AiBackend, type AiErrorReason, type AiProvider, type AiUsage, type AttemptObserver, type JsonRequest, type JsonResult } from "./provider.js";

export type OpenRouterReasoning = "none" | "minimal" | "low" | "medium" | "high";

export interface OpenRouterOptions {
  apiKey: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** Reasoning effort for models that think (Gemini 3.x). Default "low" (same as the direct Gemini provider). "none" = off. */
  reasoning?: OpenRouterReasoning;
  /** "json_schema" (default: structured outputs) or "json_object" (schema in the system prompt, like DeepSeek). */
  jsonMode?: "json_schema" | "json_object";
  /** Sent as HTTP-Referer / X-Title (OpenRouter app attribution). */
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}

export const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null; native_finish_reason?: string | null; error?: { code?: number | string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  error?: { code?: number | string; message?: string };
}

/** OpenRouter error codes (HTTP status or error.code): https://openrouter.ai/docs/api-reference/errors */
export function openRouterReason(code: number): AiErrorReason {
  if (code === 401) return "auth";
  if (code === 402) return "quota"; // no credits left
  if (code === 403) return "blocked"; // moderation
  if (code === 408) return "timeout";
  if (code === 429) return "rate_limited";
  if (code === 502 || code === 503 || code === 500) return "overloaded"; // upstream model down / no provider available
  return "http_error";
}

export class OpenRouterBackend implements AiBackend {
  readonly name = "openrouter";
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly base: string;
  private readonly reasoning: OpenRouterReasoning;
  private readonly jsonMode: "json_schema" | "json_object";
  private readonly referer: string;
  private readonly title: string;
  private readonly fetchImpl: typeof fetch;

  constructor(o: OpenRouterOptions) {
    this.key = o.apiKey;
    this.timeoutMs = o.timeoutMs ?? 25000;
    this.base = (o.baseUrl ?? OPENROUTER_DEFAULT_BASE).replace(/\/$/, "");
    this.reasoning = o.reasoning ?? "low";
    this.jsonMode = o.jsonMode ?? "json_schema";
    this.referer = o.referer ?? "https://github.com/NabilHadi/partsbot";
    this.title = o.title ?? "PartsBot";
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.key}`, "HTTP-Referer": this.referer, "X-Title": this.title };
  }

  async attempt(model: string, req: JsonRequest): Promise<{ data: unknown; usage: AiUsage }> {
    const schemaMode = this.jsonMode === "json_schema";
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: schemaMode ? req.system : req.system + schemaInstruction(req.jsonSchema) },
        { role: "user", content: req.user },
      ],
      response_format: schemaMode ? { type: "json_schema", json_schema: { name: `partsbot_${req.stage}`.replace(/[^a-zA-Z0-9_-]/g, "_"), strict: true, schema: req.jsonSchema } } : { type: "json_object" },
      temperature: req.temperature ?? 0.1,
      max_tokens: req.maxOutputTokens ?? 1024,
      stream: false,
      usage: { include: true },
      reasoning: this.reasoning === "none" ? { enabled: false, exclude: true } : { effort: this.reasoning, exclude: true },
      provider: { require_parameters: true },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    let json: ChatResponse;
    try {
      res = await this.fetchImpl(`${this.base}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: ctrl.signal });
      try {
        json = (await res.json()) as ChatResponse;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        throw new AiError(res.ok ? "bad_json" : openRouterReason(res.status), `status=${res.status} non_json`);
      }
    } catch (err) {
      if (err instanceof AiError) throw err;
      if ((err as Error)?.name === "AbortError") throw new AiError("timeout", `>${this.timeoutMs}ms`);
      throw new AiError("network", (err as Error)?.name ?? "fetch_failed");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new AiError(openRouterReason(res.status), `status=${res.status}`);
    const u = json.usage ?? {};
    const usage: AiUsage = {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0, // includes reasoning tokens (billed as output)
      cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      ...(typeof u.cost === "number" ? { costUsd: u.cost } : {}),
    };
    // A 200 can still carry an upstream error (in the body or on the choice).
    const bodyErr = json.error?.code ?? json.choices?.[0]?.error?.code;
    if (bodyErr !== undefined && !json.choices?.[0]?.message?.content) {
      const n = Number(bodyErr);
      throw new AiError(Number.isFinite(n) ? openRouterReason(n) : "http_error", `error_code=${String(bodyErr).slice(0, 20)}`, usage);
    }
    const choice = json.choices?.[0];
    const text = (choice?.message?.content ?? "").trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
    const finish = choice?.finish_reason ?? "none";
    if (finish === "content_filter") throw new AiError("blocked", "finish=content_filter", usage);
    if (!text) throw new AiError("empty", `finish=${finish}`, usage);
    try {
      return { data: JSON.parse(text), usage };
    } catch {
      throw new AiError("bad_json", `finish=${finish} length=${text.length}`, usage);
    }
  }

  /** GET /key (is the key accepted?) then GET /models (is the model listed?). Never throws, never returns key details. */
  async checkModel(model: string): Promise<{ ok: boolean; detail: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const k = await this.fetchImpl(`${this.base}/key`, { headers: { authorization: `Bearer ${this.key}` }, signal: ctrl.signal });
      if (k.status === 401 || k.status === 403) return { ok: false, detail: `key rejected (HTTP ${k.status})` };
      if (!k.ok) return { ok: false, detail: `HTTP ${k.status}` };
      const res = await this.fetchImpl(`${this.base}/models`, { headers: { authorization: `Bearer ${this.key}` }, signal: ctrl.signal });
      if (!res.ok) return { ok: true, detail: `key accepted; model list HTTP ${res.status}` };
      const j = (await res.json()) as { data?: { id?: string }[] };
      return (j.data ?? []).some((m) => m.id === model) ? { ok: true, detail: "model available, key accepted" } : { ok: false, detail: "key accepted; model id not listed by GET /models" };
    } catch (err) {
      return { ok: false, detail: (err as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** OpenRouter on its own (retry on OPENROUTER_FALLBACK_MODEL or the same model). */
export class OpenRouterProvider implements AiProvider {
  readonly name = "openrouter";
  readonly model: string;
  readonly fallbackModel: string | null;
  readonly fallbackProvider = null;
  readonly backend: OpenRouterBackend;
  private readonly chain: ChainProvider;

  constructor(o: OpenRouterOptions & { model: string; fallbackModel?: string | null; observer?: AttemptObserver }) {
    this.model = o.model;
    this.fallbackModel = o.fallbackModel ?? null;
    this.backend = new OpenRouterBackend(o);
    this.chain = new ChainProvider([{ backend: this.backend, model: o.model }, { backend: this.backend, model: o.fallbackModel ?? o.model }], o.observer);
  }

  generateJson(req: JsonRequest): Promise<JsonResult> {
    return this.chain.generateJson(req);
  }

  check(): Promise<{ ok: boolean; detail: string }> {
    return this.backend.checkModel(this.model);
  }
}
