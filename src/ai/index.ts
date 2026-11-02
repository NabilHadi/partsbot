/** The AI bundle the engine receives (EngineDeps.ai). Provider-neutral: Gemini today, another provider later. */
import type { AiProvider } from "./provider.js";
import { GeminiProvider } from "./gemini.js";
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

export interface AiConfigLike {
  AI_ENABLED: boolean;
  AI_PROVIDER: "gemini";
  AI_MODEL: string;
  AI_FALLBACK_MODEL: string | null;
  AI_TIMEOUT_MS: number;
  GEMINI_API_KEY?: string | undefined;
}

export type AiSetup =
  | { enabled: true; provider: AiProvider }
  | { enabled: false; reason: "disabled" | "no_key"; provider: null };

/** null provider = AI off server-wide (AI_ENABLED=false or no key): every shop runs on the rules. */
export function createAiFromConfig(cfg: AiConfigLike): AiSetup {
  if (!cfg.AI_ENABLED) return { enabled: false, reason: "disabled", provider: null };
  if (!cfg.GEMINI_API_KEY) return { enabled: false, reason: "no_key", provider: null };
  return {
    enabled: true,
    provider: new GeminiProvider({ apiKey: cfg.GEMINI_API_KEY, model: cfg.AI_MODEL, fallbackModel: cfg.AI_FALLBACK_MODEL, timeoutMs: cfg.AI_TIMEOUT_MS }),
  };
}

export type { AiProvider } from "./provider.js";
