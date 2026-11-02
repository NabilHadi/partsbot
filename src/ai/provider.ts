/**
 * Provider-neutral model interface. The bot only ever asks for ONE JSON object that matches a JSON schema;
 * the provider turns that into its own API call (Gemini today, OpenAI can be added behind the same interface).
 *
 * Errors are typed and never carry the API key, the prompt or the model's text: only a short reason code.
 */

export interface AiUsage {
  inputTokens: number;
  /** Visible output plus thinking tokens (both are billed as output). */
  outputTokens: number;
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
  attempts: number;
}

export type AiErrorReason = "timeout" | "rate_limited" | "overloaded" | "http_error" | "auth" | "bad_json" | "blocked" | "empty" | "network" | "disabled";

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
  generateJson(req: JsonRequest): Promise<JsonResult>;
  /** Cheap liveness check for /admin/app: is the configured model visible with this key? Never throws. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

/** USD per 1M tokens, for the cost estimate in logs/eval. Update with the provider's price page. */
export const PRICES_PER_M: Record<string, { input: number; output: number }> = {
  // https://ai.google.dev/gemini-api/docs/pricing (introductory price through 2026-12-31; doubles on 2027-01-01)
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
};

export function costUsd(model: string, u: AiUsage): number | null {
  const p = PRICES_PER_M[model];
  if (!p) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output) / 1_000_000;
}
