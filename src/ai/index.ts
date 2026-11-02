/** The AI bundle the engine receives (EngineDeps.ai). Provider-neutral: Gemini and DeepSeek behind AiProvider. */
import { ChainProvider, type AiBackend, type AiProvider, type AttemptObserver } from "./provider.js";
import { GeminiBackend } from "./gemini.js";
import { DeepSeekBackend } from "./deepseek.js";
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

export const AI_PROVIDERS = ["gemini", "deepseek"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export interface AiConfigLike {
  AI_ENABLED: boolean;
  AI_PROVIDER: AiProviderName;
  AI_FALLBACK_PROVIDER?: AiProviderName | null;
  AI_TIMEOUT_MS: number;
  GEMINI_MODEL: string;
  GEMINI_FALLBACK_MODEL?: string | null;
  GEMINI_API_KEY?: string | undefined;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_FALLBACK_MODEL?: string | null;
  DEEPSEEK_THINKING?: "disabled" | "low" | "high";
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string | undefined;
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
  | { enabled: true; provider: AiProvider; byProvider: Partial<Record<AiProviderName, AiProvider>>; chains: AiChainInfo[] }
  | { enabled: false; reason: "disabled" | "no_key"; provider: null; byProvider: Partial<Record<AiProviderName, AiProvider>>; chains: AiChainInfo[] };

/**
 * One chain per provider that has a key: [provider main model] -> retry on [AI_FALLBACK_PROVIDER's main model] when that
 * is another provider with a key, else on the provider's own fallback model (or the same model).
 * `provider` = the server default (AI_PROVIDER). Null = AI off server-wide: every shop runs on the rules.
 */
export function createAiFromConfig(cfg: AiConfigLike, observer?: AttemptObserver): AiSetup {
  const backends: Partial<Record<AiProviderName, { backend: AiBackend; model: string; fallbackModel: string | null }>> = {};
  if (cfg.GEMINI_API_KEY) {
    backends.gemini = { backend: new GeminiBackend({ apiKey: cfg.GEMINI_API_KEY, timeoutMs: cfg.AI_TIMEOUT_MS }), model: cfg.GEMINI_MODEL, fallbackModel: cfg.GEMINI_FALLBACK_MODEL ?? null };
  }
  if (cfg.DEEPSEEK_API_KEY) {
    backends.deepseek = {
      backend: new DeepSeekBackend({ apiKey: cfg.DEEPSEEK_API_KEY, timeoutMs: cfg.AI_TIMEOUT_MS, thinking: cfg.DEEPSEEK_THINKING ?? "disabled", ...(cfg.DEEPSEEK_BASE_URL ? { baseUrl: cfg.DEEPSEEK_BASE_URL } : {}) }),
      model: cfg.DEEPSEEK_MODEL ?? "deepseek-flash",
      fallbackModel: cfg.DEEPSEEK_FALLBACK_MODEL ?? null,
    };
  }
  const byProvider: Partial<Record<AiProviderName, AiProvider>> = {};
  const chains: AiChainInfo[] = [];
  const order = [cfg.AI_PROVIDER, ...AI_PROVIDERS.filter((p) => p !== cfg.AI_PROVIDER)];
  for (const name of order) {
    const b = backends[name];
    if (!b) {
      if (name === cfg.AI_PROVIDER) chains.push({ provider: name, model: name === "gemini" ? cfg.GEMINI_MODEL : (cfg.DEEPSEEK_MODEL ?? "deepseek-flash"), fallbackProvider: null, fallbackModel: null, keyConfigured: false });
      continue;
    }
    const other = cfg.AI_FALLBACK_PROVIDER && cfg.AI_FALLBACK_PROVIDER !== name ? backends[cfg.AI_FALLBACK_PROVIDER] : undefined;
    const second = other ? { backend: other.backend, model: other.model } : { backend: b.backend, model: b.fallbackModel ?? b.model };
    const chain = new ChainProvider([{ backend: b.backend, model: b.model }, second], observer);
    byProvider[name] = chain;
    chains.push({ provider: name, model: b.model, fallbackProvider: chain.fallbackProvider, fallbackModel: chain.fallbackModel, keyConfigured: true });
  }
  const main = byProvider[cfg.AI_PROVIDER];
  if (!cfg.AI_ENABLED) return { enabled: false, reason: "disabled", provider: null, byProvider: {}, chains };
  if (!main) return { enabled: false, reason: "no_key", provider: null, byProvider: {}, chains };
  return { enabled: true, provider: main, byProvider, chains };
}

export type { AiProvider } from "./provider.js";
