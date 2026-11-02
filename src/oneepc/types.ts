// Zod schemas for the OneEPC Bot API v1 (see MVP Technical Plan, "OneEPC Bot API spec").
// Unknown fields are stripped (spec: "the bot ignores fields it does not know").
// Enum-like fields the spec says may grow (ambiguity reason) are plain strings.
import { z } from "zod";

/** Text pair; `ar` is null when OneEPC has no Arabic name. Never translate it ourselves. */
export const localizedSchema = z.object({
  ar: z.string().nullable(),
  en: z.string().nullable(),
});
export type Localized = z.infer<typeof localizedSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().nullish(),
  }),
});

// ---- 1. GET /vehicles/decode ----

export const vehicleSchema = z.object({
  vehicle_id: z.string(),
  vin: z.string(),
  brand: z.string(),
  make: z.string(),
  model: localizedSchema,
  model_code: z.string().nullable(),
  year: z.number().int().nullable(),
  engine: z.string().nullable(),
  trim: z.string().nullable(),
  transmission: z.string().nullable(),
  market: z.string().nullable(),
  production_date: z.string().nullable(),
});
export type Vehicle = z.infer<typeof vehicleSchema>;

/** Ambiguous-decode option: its own vehicle_id plus the field(s) that differ. Spec gap: exact shape not given. */
export const vehicleCandidateSchema = vehicleSchema
  .partial()
  .extend({ vehicle_id: z.string(), differs_by: z.string() });
export type VehicleCandidate = z.infer<typeof vehicleCandidateSchema>;

export const decodeResponseSchema = z.object({
  match: z.enum(["exact", "ambiguous", "none"]),
  vehicle: vehicleSchema.nullable(),
  candidates: z.array(vehicleCandidateSchema).default([]),
});
export type DecodeResponse = z.infer<typeof decodeResponseSchema>;

// ---- 2. GET /vehicles/{vehicle_id}/parts/search ----

export const fitmentSchema = z.object({
  status: z.enum(["confirmed", "conditional", "unknown"]),
  conditions: z.array(z.string()).default([]),
});
export type Fitment = z.infer<typeof fitmentSchema>;

export const searchAmbiguitySchema = z.object({
  is_ambiguous: z.boolean(),
  // multiple_variants | multiple_positions | broad_query | low_text_match (may grow: treat unknown as ambiguous)
  reason: z.string().nullish(),
  differs_by: z.string().nullish(),
  question_hint: localizedSchema.nullish(),
});
export type SearchAmbiguity = z.infer<typeof searchAmbiguitySchema>;

export const partResultSchema = z.object({
  part_number: z.string(),
  name: localizedSchema,
  category: z.object({ id: z.string(), ar: z.string().nullable(), en: z.string().nullable() }),
  diagram_id: z.string().nullish(),
  callout: z.string().nullish(),
  quantity_per_vehicle: z.number().int().nullish(), // optional in spec
  fitment: fitmentSchema,
  score: z.number(),
});
export type PartResult = z.infer<typeof partResultSchema>;

export const searchResponseSchema = z.object({
  vehicle_id: z.string(),
  // lang_detected: ar | en (the mock also emits "mixed"; spec gap), so a plain string.
  query: z.object({ q: z.string().nullish(), lang_detected: z.string().nullish() }),
  ambiguity: searchAmbiguitySchema,
  results: z.array(partResultSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export type Lang = "ar" | "en" | "auto";

// ---- GET /status (live on oneepc.com since Hyundai PR #239) ----
// Real body: { ok: true, api_version: "1.0", data_version: <sha256 hex>, brands: [...], markets: { brand: [codes] } }

export const statusResponseSchema = z.object({
  ok: z.literal(true),
  api_version: z.string(),
  data_version: z.string(),
  brands: z.array(z.string()),
  markets: z.record(z.string(), z.array(z.string())).default({}),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;
