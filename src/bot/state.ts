import { z } from "zod";
import type { ShopConfig } from "./shop-config.js";

/**
 * Per-conversation state, persisted as JSON (table bot_conversation_state, migration 003).
 * Kept small on purpose: no phone numbers, no message history, only what the next turn needs.
 * `vin` and the remembered part request are the only customer-supplied strings it holds.
 */

export const STEPS = [
  "idle", // nothing pending
  "awaiting_vin", // we have (or are waiting for) a part request, need the VIN
  "awaiting_variant", // VIN decoded as ambiguous: customer must pick one candidate
  "awaiting_part", // vehicle known: waiting for the part request
  "awaiting_clarification", // part search was ambiguous: waiting for the answer to question_hint
  "handoff", // staff took over: bot stays silent until the silence window ends
] as const;
export type Step = (typeof STEPS)[number];

export const vehicleRefSchema = z.object({
  vehicleId: z.string(),
  make: z.string().nullable(),
  modelAr: z.string().nullable(),
  modelEn: z.string().nullable(),
  year: z.number().int().nullable(),
  trim: z.string().nullable(),
  engine: z.string().nullable().default(null),
  transmission: z.string().nullable().default(null),
  market: z.string().nullable().default(null),
  productionDate: z.string().nullable().default(null),
  /** Candidates only: which field(s) separate this option from the others (from the API). */
  differsBy: z.string().nullable().default(null),
  /** The customer has said yes (or implicitly accepted by asking for a part). */
  acknowledged: z.boolean().default(false),
});
export type VehicleRef = z.infer<typeof vehicleRefSchema>;

export const conversationStateSchema = z.object({
  v: z.literal(1),
  step: z.enum(STEPS),
  lang: z.enum(["ar", "en"]).default("ar"),
  vin: z.string().nullable().default(null),
  vehicle: vehicleRefSchema.nullable().default(null),
  candidates: z.array(vehicleRefSchema).default([]),
  /** The customer's part request (cleaned), remembered while we wait for the VIN or a variant choice. */
  pendingPart: z.string().nullable().default(null),
  clarification: z
    .object({ baseQuery: z.string(), question: z.string(), rounds: z.number().int() })
    .nullable()
    .default(null),
  /** Small loop breakers so the bot never asks the same thing forever. */
  counters: z
    .object({
      invalidVin: z.number().int().default(0),
      variantReprompts: z.number().int().default(0),
      failedSearches: z.number().int().default(0),
      offTopic: z.number().int().default(0),
    })
    .default({ invalidVin: 0, variantReprompts: 0, failedSearches: 0, offTopic: 0 }),
  turns: z.number().int().default(0),
  handoffReason: z.string().nullable().default(null),
  /** Riyadh date (YYYY-MM-DD) on which the "daily cap reached" message was sent; silence afterwards that day. */
  capNotifiedDay: z.string().nullable().default(null),
  /** Provider message id of the last inbound message handled (lets the worker skip a replayed job). */
  lastMessageId: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export function newState(now: Date, lang: "ar" | "en" = "ar"): ConversationState {
  return conversationStateSchema.parse({ v: 1, step: "idle", lang, updatedAt: now.toISOString() });
}

/** Parse a JSON blob from the database; anything unreadable (old schema, corruption) becomes a fresh state. */
export function parseState(raw: unknown, now: Date): ConversationState {
  const parsed = conversationStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : newState(now);
}

/** Inactivity reset. After a handoff the bot stays quiet for `handoffSilenceMinutes`, otherwise `sessionTtlMinutes`. */
export function isExpired(
  state: ConversationState,
  now: Date,
  cfg: Pick<ShopConfig, "sessionTtlMinutes" | "handoffSilenceMinutes">,
): boolean {
  const idleMs = now.getTime() - new Date(state.updatedAt).getTime();
  const ttlMin = state.step === "handoff" ? cfg.handoffSilenceMinutes : cfg.sessionTtlMinutes;
  return idleMs > ttlMin * 60_000;
}

/** Start over but keep what must survive a reset: language and the "cap message already sent today" marker. */
export function resetState(state: ConversationState, now: Date): ConversationState {
  const fresh = newState(now, state.lang);
  fresh.capNotifiedDay = state.capNotifiedDay;
  fresh.lastMessageId = state.lastMessageId;
  return fresh;
}

export const vehicleDisplayName = (v: VehicleRef, lang: "ar" | "en"): string =>
  [v.make, lang === "ar" ? (v.modelAr ?? v.modelEn) : (v.modelEn ?? v.modelAr), v.year, v.trim]
    .filter((x) => x !== null && x !== undefined && x !== "")
    .join(" ");
