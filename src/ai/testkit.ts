// Test helpers for the AI layer: a scripted provider (no network). Tests only.
import { AiError, type AiProvider, type JsonRequest, type JsonResult } from "./provider.js";
import type { Understanding } from "./understand.js";

export type Script = (req: JsonRequest) => unknown | Promise<unknown>;

export function scriptedProvider(script: Script, model = "test-model"): AiProvider & { calls: JsonRequest[] } {
  const calls: JsonRequest[] = [];
  return {
    name: "scripted",
    model,
    fallbackModel: null,
    calls,
    async generateJson(req: JsonRequest): Promise<JsonResult> {
      calls.push(req);
      const data = await script(req);
      return { data, usage: { inputTokens: 100, outputTokens: 20 }, latencyMs: 5, model, attempts: 1 };
    },
    async check() {
      return { ok: true, detail: "scripted" };
    },
  };
}

/** The DRAFT block of a compose prompt. */
export const draftOf = (req: JsonRequest) => /DRAFT:\n<<<\n([\s\S]*)\n>>>$/.exec(req.user)?.[1] ?? "";
/** The customer's message in an understand prompt. */
export const messageOf = (req: JsonRequest) => /New customer message:\n<<<\n([\s\S]*)\n>>>$/.exec(req.user)?.[1] ?? "";

export function understanding(o: Partial<Omit<Understanding, "parts">> & { parts?: Partial<Understanding["parts"][number]>[] } = {}): Understanding {
  return {
    intent: o.intent ?? "part_request",
    vin_or_frame: o.vin_or_frame ?? null,
    parts: (o.parts ?? []).map((p) => ({
      customer_words: p.customer_words ?? "",
      normalized_en: p.normalized_en ?? "",
      normalized_ar: p.normalized_ar ?? "",
      position: p.position ?? null,
      qty: p.qty ?? null,
    })),
    clarification_needed: o.clarification_needed ?? false,
  };
}

export const failWith = (reason: ConstructorParameters<typeof AiError>[0]) => () => {
  throw new AiError(reason, "scripted");
};
