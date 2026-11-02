/** The AI bundle the engine receives (EngineDeps.ai). Provider-neutral: Gemini, DeepSeek and OpenRouter behind AiProvider. */
import { ChainProvider, type AiBackend, type AiProvider, type AttemptObserver } from "./provider.js";
import { GeminiBackend } from "./gemini.js";
import { DeepSeekBackend } from "./deepseek.js";
import { OpenRouterBackend, type OpenRouterReasoning } from "./openrouter.js";
import { composeReply, type ComposeInput, type ComposeOutcome } from "./compose.js";
import { selectCandidates, type SelectInput, type SelectOutcome } from "./select.js";
import { understandMessage, type UnderstandInput, type UnderstandOutcome } from "./understand.js";

export interface EngineAi {
  model: string;
  understand(i: UnderstandInput): Promise<UnderstandOutcome>;
  select(i: SelectInput): Promise<SelectOutcome>;
  compose(i: ComposeInput): Promise<ComposeOutcome>;
}

export function engineAi(provider: AiProvider): EngineAi {
  return {
    model: provider.model,
    understand: (i) => understandMessage(provider, i),
    select: (i) => selectCandidates(provider, i),
    compose: (i) => composeReply(provider, i),
  };
}

export const AI_PROVIDERS = ["gemini", "deepseek", "openrouter"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export interface AiConfigLike {
  AI_ENABLED: boolean;
  AI_PROVIDER: AiProviderName;
  /** Primary model (for AI_PROVIDER). Unset = that provider's *_MODEL. */
  AI_MODEL?: string | null;
  AI_FALLBACK_PROVIDER?: AiProviderName | null;
  /** Fallback model (for AI_FALLBACK_PROVIDER). Unset = that provider's *_MODEL. */
  AI_FALLBACK_MODEL?: string | null;
  AI_TIMEOUT_MS: number;
  GEMINI_MODEL: string;
  GEMINI_FALLBACK_MODEL?: string | null;
  GEMINI_API_KEY?: string | undefined;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_FALLBACK_MODEL?: string | null;
  DEEPSEEK_THINKING?: "disabled" | "low" | "high";
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string | undefined;
  OPENROUTER_MODEL?: string;
  OPENROUTER_FALLBACK_MODEL?: string | null;
  OPENROUTER_REASONING?: OpenRouterReasoning;
  OPENROUTER_JSON_MODE?: "json_schema" | "json_object";
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_API_KEY?: string | undefined;
}

export const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.8-flash";

/** Main model of a provider's chain: AI_MODEL for the primary provider when set, else the provider's *_MODEL. */
function mainModel(cfg: AiConfigLike, name: AiProviderName): string {
  return name === cfg.AI_PROVIDER && cfg.AI_MODEL ? cfg.AI_MODEL : providerModel(cfg, name);
}

/** A provider's own default model (*_MODEL). */
function providerModel(cfg: AiConfigLike, name: AiProviderName): string {
  return name === "gemini" ? cfg.GEMINI_MODEL : name === "deepseek" ? (cfg.DEEPSEEK_MODEL ?? "deepseek-flash") : (cfg.OPENROUTER_MODEL ?? OPENROUTER_DEFAULT_MODEL);
}

/** What /admin/app shows per provider chain (never a key). */
export interface AiChainInfo {
  provider: AiProviderName;
  model: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
  keyConfigured: boolean;
}

export type AiSetup =
  | { enabled: true; provider: AiProvider; byProvider: Partial<Record<AiProviderName, AiProvider>>; chains: AiChainInfo[]; primary: AiRoute; fallback: AiRoute | null; warnings: string[] }
  | { enabled: false; reason: "disabled" | "no_key"; provider: null; byProvider: Partial<Record<AiProviderName, AiProvider>>; chains: AiChainInfo[]; primary: AiRoute; fallback: AiRoute | null; warnings: string[] };

/** A provider + model pair as configured (for /admin/app and logs; never a key). */
export interface AiRoute {
  provider: AiProviderName;
  model: string;
  keyConfigured: boolean;
}

/**
 * Primary + fallback, from config:
 *   primary  = AI_PROVIDER with AI_MODEL (default: that provider's *_MODEL)
 *   fallback = AI_FALLBACK_PROVIDER with AI_FALLBACK_MODEL (default: that provider's *_MODEL). It may be another provider.
 * Every call makes ONE attempt on the primary; when it times out, errors (HTTP, rate limit, quota, auth, network) or
 * returns empty / invalid JSON / JSON that fails the stage's schema, the ONE retry goes to the fallback.
 * Without AI_FALLBACK_PROVIDER (or without its key) the retry stays on the same provider, on its *_FALLBACK_MODEL or the same model.
 * One chain per provider that has a key: shops pick one with their `aiProvider` setting; those chains use the same
 * fallback (unless the shop's provider IS the fallback provider: then its own fallback model or the same model).
 * `provider` = the server default chain. Null = AI off server-wide: every shop runs on the rules.
 */
export function createAiFromConfig(cfg: AiConfigLike, observer?: AttemptObserver): AiSetup {
  const backends: Partial<Record<AiProviderName, { backend: AiBackend; model: string; fallbackModel: string | null }>> = {};
  if (cfg.GEMINI_API_KEY) {
    backends.gemini = { backend: new GeminiBackend({ apiKey: cfg.GEMINI_API_KEY, timeoutMs: cfg.AI_TIMEOUT_MS }), model: mainModel(cfg, "gemini"), fallbackModel: cfg.GEMINI_FALLBACK_MODEL ?? null };
  }
  if (cfg.DEEPSEEK_API_KEY) {
    backends.deepseek = {
      backend: new DeepSeekBackend({ apiKey: cfg.DEEPSEEK_API_KEY, timeoutMs: cfg.AI_TIMEOUT_MS, thinking: cfg.DEEPSEEK_THINKING ?? "disabled", ...(cfg.DEEPSEEK_BASE_URL ? { baseUrl: cfg.DEEPSEEK_BASE_URL } : {}) }),
      model: mainModel(cfg, "deepseek"),
      fallbackModel: cfg.DEEPSEEK_FALLBACK_MODEL ?? null,
    };
  }
  if (cfg.OPENROUTER_API_KEY) {
    backends.openrouter = {
      backend: new OpenRouterBackend({
        apiKey: cfg.OPENROUTER_API_KEY, timeoutMs: cfg.AI_TIMEOUT_MS, reasoning: cfg.OPENROUTER_REASONING ?? "low", jsonMode: cfg.OPENROUTER_JSON_MODE ?? "json_schema",
        ...(cfg.OPENROUTER_BASE_URL ? { baseUrl: cfg.OPENROUTER_BASE_URL } : {}),
      }),
      model: mainModel(cfg, "openrouter"),
      fallbackModel: cfg.OPENROUTER_FALLBACK_MODEL ?? null,
    };
  }
  const warnings: string[] = [];
  const fbName = cfg.AI_FALLBACK_PROVIDER ?? null;
  const fbModel = fbName ? (cfg.AI_FALLBACK_MODEL ?? providerModel(cfg, fbName)) : null;
  const fbBackend = fbName ? backends[fbName] : undefined;
  if (fbName && !fbBackend) warnings.push(`AI_FALLBACK_PROVIDER=${fbName} has no API key: retries stay on the same provider`);
  const byProvider: Partial<Record<AiProviderName, AiProvider>> = {};
  const chains: AiChainInfo[] = [];
  const order = [cfg.AI_PROVIDER, ...AI_PROVIDERS.filter((p) => p !== cfg.AI_PROVIDER)];
  for (const name of order) {
    const b = backends[name];
    if (!b) {
      if (name === cfg.AI_PROVIDER) chains.push({ provider: name, model: mainModel(cfg, name), fallbackProvider: null, fallbackModel: null, keyConfigured: false });
      continue;
    }
    let second: { backend: AiBackend; model: string };
    if (fbBackend && fbName && fbModel && fbName !== name) second = { backend: fbBackend.backend, model: fbModel };
    else if (fbBackend && fbName === name && cfg.AI_FALLBACK_MODEL) second = { backend: b.backend, model: cfg.AI_FALLBACK_MODEL };
    else second = { backend: b.backend, model: b.fallbackModel ?? b.model };
    const chain = new ChainProvider([{ backend: b.backend, model: b.model }, second], observer);
    byProvider[name] = chain;
    chains.push({ provider: name, model: b.model, fallbackProvider: chain.fallbackProvider, fallbackModel: chain.fallbackModel, keyConfigured: true });
  }
  const primary: AiRoute = { provider: cfg.AI_PROVIDER, model: mainModel(cfg, cfg.AI_PROVIDER), keyConfigured: !!backends[cfg.AI_PROVIDER] };
  const fallback: AiRoute | null = fbName && fbModel ? { provider: fbName, model: fbModel, keyConfigured: !!fbBackend } : null;
  const main = byProvider[cfg.AI_PROVIDER];
  const common = { chains, primary, fallback, warnings };
  if (!cfg.AI_ENABLED) return { enabled: false, reason: "disabled", provider: null, byProvider: {}, ...common };
  if (!main) return { enabled: false, reason: "no_key", provider: null, byProvider: {}, ...common };
  return { enabled: true, provider: main, byProvider, ...common };
}

export type { AiProvider } from "./provider.js";
