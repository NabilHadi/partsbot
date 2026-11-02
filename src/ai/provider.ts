/**
 * Provider-neutral model interface. The bot only ever asks for ONE JSON object that matches a JSON schema;
 * the provider turns that into its own API call (Gemini and DeepSeek today; any other backend fits the same interface).
 *
 * Errors are typed and never carry the API key, the prompt or the model's text: only a short reason code.
 */
import { randomUUID } from "node:crypto";

export interface AiUsage {
  inputTokens: number;
  /** Visible output plus thinking tokens (both are billed as output). */
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (DeepSeek bills them much lower). Part of inputTokens. */
  cachedInputTokens?: number;
}

export interface JsonRequest {
  /** Short stage name for logs ("understand", "select", "compose"). */
  stage: string;
  system: string;
  user: string;
  /** JSON Schema (draft 2020-12 subset: type, properties, required, enum, items, nullable via type arrays). */
  jsonSchema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface JsonResult {
  /** Parsed JSON (NOT yet validated: callers validate with zod). */
  data: unknown;
  usage: AiUsage;
  latencyMs: number;
  /** Model that actually answered (the fallback model when the retry used it). */
  model: string;
  /** Provider that actually answered (another one when a cross-provider retry answered). */
  provider?: string;
  attempts: number;
}

export type AiErrorReason = "timeout" | "quota" | "rate_limited" | "overloaded" | "http_error" | "auth" | "bad_json" | "blocked" | "empty" | "network" | "disabled";

export class AiError extends Error {
  constructor(
    readonly reason: AiErrorReason,
    readonly detail: string,
    readonly usage: AiUsage = { inputTokens: 0, outputTokens: 0 },
    readonly latencyMs = 0,
  ) {
    super(`ai_${reason}: ${detail}`);
    this.name = "AiError";
  }
  /** Worth one retry. */
  get retryable(): boolean {
    return ["timeout", "rate_limited", "overloaded", "http_error", "bad_json", "empty", "network"].includes(this.reason);
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  readonly fallbackModel: string | null;
  /** Provider used for the retry when it differs from `name` (cross-provider fallback); null = same provider. */
  readonly fallbackProvider?: string | null;
  generateJson(req: JsonRequest): Promise<JsonResult>;
  /** Cheap liveness check for /admin/app: is the configured model visible with this key? Never throws. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

/** One HTTP attempt, reported to an optional observer (recent-call health on /admin/app). Metrics only, never text. */
export interface AttemptEvent {
  /** Same for every attempt of one generateJson call. */
  callId: string;
  /** Last attempt of the call: its `ok` is the call's outcome. */
  final: boolean;
  provider: string;
  model: string;
  stage: string;
  attempt: number;
  ok: boolean;
  reason: AiErrorReason | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}
export type AttemptObserver = (e: AttemptEvent) => void;

/** A model API that can make ONE attempt. Retry/fallback across attempts lives in ChainProvider. */
export interface AiBackend {
  readonly name: string;
  attempt(model: string, req: JsonRequest): Promise<{ data: unknown; usage: AiUsage }>;
  checkModel(model: string): Promise<{ ok: boolean; detail: string }>;
}

export interface ChainStep {
  backend: AiBackend;
  model: string;
}

/**
 * The shared timeout/retry policy: attempt 1 on the primary step; ONE retry on the second step.
 * Retry when the error is transient, or (quota / auth / http_error) when the second step is a different model or
 * provider, whose quota and key are separate.
 */
export class ChainProvider implements AiProvider {
  readonly name: string;
  readonly model: string;
  readonly fallbackModel: string | null;
  readonly fallbackProvider: string | null;
  constructor(
    private readonly steps: [ChainStep, ChainStep],
    private readonly observer?: AttemptObserver,
  ) {
    this.name = steps[0].backend.name;
    this.model = steps[0].model;
    const second = steps[1];
    this.fallbackModel = second.model !== steps[0].model || second.backend !== steps[0].backend ? second.model : null;
    this.fallbackProvider = second.backend.name !== this.name ? second.backend.name : null;
  }

  async generateJson(req: JsonRequest): Promise<JsonResult> {
    const started = Date.now();
    const total: AiUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let lastErr: AiError | null = null;
    const callId = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const step = this.steps[attempt]!;
      const t0 = Date.now();
      try {
        const r = await step.backend.attempt(step.model, req);
        addUsage(total, r.usage);
        this.emit(callId, true, step, req, attempt, null, Date.now() - t0, r.usage);
        return { data: r.data, usage: total, latencyMs: Date.now() - started, model: step.model, provider: step.backend.name, attempts: attempt + 1 };
      } catch (err) {
        const e = err instanceof AiError ? err : new AiError("network", (err as Error)?.name ?? "unknown");
        addUsage(total, e.usage);
        lastErr = e;
        const next = this.steps[1];
        const otherTarget = next.backend !== step.backend || next.model !== step.model;
        const retry = attempt === 0 && (e.retryable || (otherTarget && ["quota", "auth", "http_error"].includes(e.reason)));
        this.emit(callId, !retry, step, req, attempt, e.reason, Date.now() - t0, e.usage);
        if (!retry) break;
      }
    }
    throw new AiError(lastErr!.reason, lastErr!.detail, total, Date.now() - started);
  }

  check(): Promise<{ ok: boolean; detail: string }> {
    return this.steps[0].backend.checkModel(this.model);
  }

  private emit(callId: string, final: boolean, step: ChainStep, req: JsonRequest, attempt: number, reason: AiErrorReason | null, latencyMs: number, u: AiUsage): void {
    if (!this.observer) return;
    try {
      this.observer({
        callId, final, provider: step.backend.name, model: step.model, stage: req.stage, attempt: attempt + 1, ok: reason === null, reason, latencyMs,
        inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens ?? 0,
      });
    } catch {
      /* observers are best effort */
    }
  }
}

function addUsage(total: AiUsage, u: AiUsage): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0);
}

/** USD per 1M tokens, for the cost estimate in logs/eval. Update with the provider's price page. */
export interface Price {
  input: number;
  output: number;
  /** Price of cache-hit input tokens (else = input). */
  cachedInput?: number;
  /** Discount factor outside peak hours (DeepSeek: 0.5), with the peak test (UTC). */
  offPeak?: { factor: number; isPeak: (at: Date) => boolean };
}

/** DeepSeek peak: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday (Chinese public holidays are off-peak; not modelled). */
export function deepseekIsPeak(at: Date): boolean {
  const d = at.getUTCDay();
  if (d === 0 || d === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export const PRICES_PER_M: Record<string, Price> = {
  // https://ai.google.dev/gemini-api/docs/pricing (introductory price through 2026-12-31; doubles on 2027-01-01)
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  // https://api-docs.deepseek.com/quick_start/pricing (checked 2026-11-02): PEAK prices; off-peak is half.
  // deepseek-flash = DeepSeek-V4.1-Flash; legacy "deepseek-v4-flash" routes to it and bills the same.
  "deepseek-flash": { input: 0.3, cachedInput: 0.006, output: 1.2, offPeak: { factor: 0.5, isPeak: deepseekIsPeak } },
  "deepseek-v4-flash": { input: 0.3, cachedInput: 0.006, output: 1.2, offPeak: { factor: 0.5, isPeak: deepseekIsPeak } },
};

/** Estimated cost. `at` picks peak/off-peak where the provider has it; without `at`, the (higher) peak price. */
export function costUsd(model: string, u: AiUsage, at?: Date): number | null {
  const p = PRICES_PER_M[model];
  if (!p) return null;
  const cached = Math.min(u.cachedInputTokens ?? 0, u.inputTokens);
  const base = ((u.inputTokens - cached) * p.input + cached * (p.cachedInput ?? p.input) + u.outputTokens * p.output) / 1_000_000;
  return p.offPeak && at && !p.offPeak.isPeak(at) ? base * p.offPeak.factor : base;
}
