/**
 * The PartsBot conversation engine: PURE logic, all I/O injected (OneEPC client, clock, shop config).
 *
 *   handleInbound(state, text, deps) -> { newState, replies, actions }
 *
 * No database, no network, no WhatsApp in here, so the whole flow is unit-testable with a fake or the mock.
 *
 * Safety rules enforced here (and re-checked by guard.ts on every outgoing reply):
 *  1. A part number is quoted ONLY when OneEPC returned it with fitment.status === "confirmed", the search
 *     response was not ambiguous, and its score is >= MIN_QUOTE_SCORE. The string is copied verbatim.
 *  2. Conditional / unknown / ambiguous results are never presented as fitting: we ask the API's own Arabic
 *     question_hint, or say "يرجى التأكيد مع الموظف".
 *  3. Any OneEPC failure -> a safe "staff will follow up" reply, a handoff and an alert. No raw error text to the customer.
 *  4. Stock / price only from the shop's imported list via `deps.stock`, keyed by the quoted OneEPC number;
 *     variants are shown by label + suffix code (no new part numbers). Price only with priceQuotingEnabled.
 *     Synthetic stock only when `allowSyntheticStock` (test shop + opt-in); a lookup failure = no stock + alert.
 *  5. At the daily cap: ONE final handoff message, then silence.
 *  6. Per-shop display settings (shop-config.ts) decide what a confirmed quote shows: the part number
 *     (`showPartNumbers`; hidden = name only, the number is logged as `parts_identified` and kept in state for
 *     staff, and is NOT quotable so the guard blocks any leak), stock (`stockDisplay`), alternatives
 *     (`showAlternatives`) and prices (`priceQuotingEnabled`).
 *  7. Outside opening hours (`afterHoursMode`): one "closed now, staff follow up <when>" note per closed period,
 *     either added to the normal reply or sent alone (then no lookup at all).
 *  8. AI (optional, `deps.ai`): it only UNDERSTANDS the message (intent, VIN text, part descriptions), may narrow
 *     a list of confirmed results by index, and REPHRASES a reply code already decided. It never sees or produces
 *     part numbers; the synonym list (`deps.synonyms`) beats it; any AI failure or invalid output = the rules /
 *     the template. The parts block is code-rendered and the guard above still checks the final text.
 */
import { OneEpcError } from "../oneepc/errors.js";
import type { DecodeResponse, PartResult, SearchResponse, Vehicle, VehicleCandidate } from "../oneepc/types.js";
import type { OneEpcResult, SearchPartsParams } from "../oneepc/client.js";
import { PartNumberGuardError, assertOnlyAllowedPartNumbers } from "./guard.js";
import { extractVin, parseMessage, parseVariantChoice, type Lang, type ParsedMessage } from "./intent.js";
import { findPartNumberLikeTokens } from "./guard.js";
import { T, render, renderPartsBlock, staffFollowUp, whenText, type PartLine, type PartStockView, type StockFooter, type StockQtyView, type TemplateName } from "./arabic.js";
import type { PartStock, StockEntry, StockLookup } from "../inventory/stock.js";
import { closedPeriodKey, localTime, staffAvailability, type ShopConfig } from "./shop-config.js";
import { HISTORY_MAX, HISTORY_TEXT_MAX, isExpired, newState, resetState, vehicleDisplayName, type ConversationState, type VehicleRef } from "./state.js";
import type { EngineAi } from "../ai/index.js";
import type { Understanding } from "../ai/understand.js";
import { queryForAiPart, type PartQuery, type SynonymIndex } from "../ai/synonyms.js";
import { PARTS_PLACEHOLDER } from "../ai/validate.js";

/** Only the two OneEPC calls the bot needs; OneEpcClient satisfies this, so does a test fake. */
export interface OneEpcLike {
  decode(vin: string): Promise<OneEpcResult<DecodeResponse>>;
  searchParts(vehicleId: string, params?: SearchPartsParams): Promise<OneEpcResult<SearchResponse>>;
}

export interface EngineDeps {
  oneepc: OneEpcLike;
  now: () => Date;
  shop: ShopConfig;
  /** Bot messages already sent today (Asia/Riyadh) for this shop, from the usage counter. */
  botMessagesToday: number;
  /** Shop stock lookup, bound to this shop. Absent = never mention stock. */
  stock?: StockLookup;
  /** Must be true for any synthetic stock to be shown (test shop that opted in). Default false. */
  allowSyntheticStock?: boolean;
  /** AI assistant: present only when AI is on server-wide AND for this shop. Absent = rules + templates only. */
  ai?: EngineAi;
  /** The admin's synonym list (Gulf word -> canonical name). Applies with and without AI. */
  synonyms?: SynonymIndex;
}

export type HandoffReason =
  | "customer_request"
  | "unknown_vin"
  | "unsupported_brand"
  | "no_results"
  | "fitment_unconfirmed"
  | "clarification_failed"
  | "too_many_variants"
  | "variant_unclear"
  | "invalid_vin_repeated"
  | "off_topic_repeated"
  | "oneepc_error"
  | "guard_blocked"
  | "daily_cap"
  | "internal_error";

export type BotAction =
  | { type: "handoff"; reason: HandoffReason }
  /** Ops alert (Nabil, not the customer): something broke or needs attention. `detail` never holds customer text. */
  | { type: "alert"; severity: "warning" | "critical"; code: string; detail: string }
  /** Customer wrote while the bot is silent (handoff / daily cap): staff should look at the chat. */
  | { type: "customer_waiting" }
  /** Confirmed part numbers identified this turn (also when hidden from the customer), for logs and staff handoff. */
  | { type: "parts_identified"; partNumbers: string[]; shownToCustomer: boolean }
  /** One line per OneEPC call, for logs (request id + data version only). */
  | { type: "oneepc_call"; endpoint: "decode" | "search"; requestId: string | null; dataVersion: string | null; outcome: string }
  /** One line per AI call, for logs: never the prompt, the message or the reply. */
  | {
      type: "ai_call";
      stage: "understand" | "select" | "compose";
      ok: boolean;
      /** Why the AI result was not used (provider error, schema_invalid, validator...), null when used. */
      reason: string | null;
      model: string;
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      /** Input tokens served from the provider's cache (priced lower); part of inputTokens. */
      cachedInputTokens?: number;
      /** Cost reported by the provider (OpenRouter), when it reports one. */
      costUsd?: number;
      intent?: string;
      parts?: number;
      validator?: string | null;
    }
  /** The AI mapped customer words the synonym list does not know: stored as a PENDING suggestion for the admin. */
  | { type: "synonym_suggestion"; term: string; canonicalAr: string; canonicalEn: string };

export interface EngineResult {
  newState: ConversationState;
  /** At most one message per turn (Meta bills per bot message); an array so callers need not care. */
  replies: string[];
  actions: BotAction[];
}

/** A result is only quoted at or above this OneEPC text-match score. Tune with Nabil. */
export const MIN_QUOTE_SCORE = 0.6;
const MAX_VARIANT_OPTIONS = 5;
const MAX_CLARIFY_ROUNDS = 2;
const MAX_INVALID_VIN = 3;
const MAX_VARIANT_REPROMPTS = 2;
const MAX_FAILED_SEARCHES = 2;
const MAX_OFF_TOPIC = 3;

// ------------------------------------------------------------------ helpers

const toRef = (v: Vehicle | VehicleCandidate, acknowledged: boolean, differsBy: string | null = null): VehicleRef => ({
  vehicleId: v.vehicle_id,
  make: v.make ?? null,
  modelAr: v.model?.ar ?? null,
  modelEn: v.model?.en ?? null,
  year: v.year ?? null,
  trim: v.trim ?? null,
  engine: v.engine ?? null,
  transmission: v.transmission ?? null,
  market: v.market ?? null,
  productionDate: v.production_date ?? null,
  differsBy,
  acknowledged,
});

/** "Toyota هايلكس 2020 — 2.7L petrol": the base car plus whatever the API says differs between options. */
function candidateLabel(c: VehicleRef, lang: Lang): string {
  const fields = (c.differsBy ?? "").split(/[^a-z_]+/i).map((f) => f.toLowerCase()).filter(Boolean);
  const values: Record<string, string | null> = {
    engine: c.engine, transmission: c.transmission, market: c.market, production_date: c.productionDate, trim: c.trim,
  };
  const extra = fields.flatMap((f) => (values[f] ? [values[f] as string] : []));
  const base = [c.make, lang === "ar" ? (c.modelAr ?? c.modelEn) : (c.modelEn ?? c.modelAr), c.year].filter((x) => x !== null && x !== "").join(" ");
  const diff = extra.length > 0 ? extra : [c.engine, c.trim].filter((x): x is string => !!x);
  return diff.length > 0 ? `${base} — ${diff.join(" ")}` : base;
}

/** Arabic name if there is one, else the English name as-is (we never translate); English customers get English first. */
function partName(r: PartResult, lang: Lang): string {
  const first = lang === "ar" ? r.name.ar : r.name.en;
  const second = lang === "ar" ? r.name.en : r.name.ar;
  return first ?? second ?? r.category.ar ?? r.category.en ?? "-";
}

const pickQuestion = (q: { ar: string | null; en: string | null } | null | undefined, lang: Lang): string | null =>
  (lang === "ar" ? (q?.ar ?? q?.en) : (q?.en ?? q?.ar)) ?? null;

/** Strings from API vehicle data that may legitimately look like codes (trim "GXR-2", engine "2UR-FE"): not part numbers. */
function vehicleTokens(v: VehicleRef | null, cands: VehicleRef[]): string[] {
  return [v, ...cands].flatMap((x) => (x ? [x.trim, x.engine, x.transmission, x.market, x.productionDate, x.make, x.modelEn, x.modelAr] : [])).filter((s): s is string => !!s);
}

// ------------------------------------------------------------------ stock

const DAY_MS = 24 * 3600 * 1000;

function qtyView(e: StockEntry, showPrice: boolean): StockQtyView {
  return { qty: e.qty, priceSar: showPrice ? e.priceSar : null };
}

/**
 * Stock lines for the quoted numbers (same single reply). Never throws: a failed lookup means "no stock rows"
 * plus an ops alert. Synthetic data is dropped here too unless explicitly allowed.
 */
async function stockForQuote(t: Turn, partNumbers: string[]): Promise<{ views: Map<string, PartStockView>; footer: StockFooter | null }> {
  const views = new Map<string, PartStockView>();
  const { stock, shop, now, allowSyntheticStock } = t.deps;
  if (!stock || partNumbers.length === 0) return { views, footer: null };
  // Nothing the shop lets us show (no stock line, no price): skip the lookup.
  if (shop.stockDisplay === "hidden" && !shop.priceQuotingEnabled) return { views, footer: null };
  let found: Map<string, PartStock>;
  try {
    found = await stock(partNumbers);
  } catch (err) {
    t.actions.push({ type: "alert", severity: "warning", code: "stock_lookup_failed", detail: `error=${(err as Error)?.name ?? "unknown"}` });
    return { views, footer: null };
  }
  const usable = [...found.entries()].filter(([, ps]) => allowSyntheticStock === true || !ps.synthetic);
  if (usable.length === 0) return { views, footer: null };

  const oldest = Math.min(...usable.map(([, ps]) => ps.importedAt.getTime()));
  const stale = now().getTime() - oldest > shop.stockStaleDays * DAY_MS;
  const footer: StockFooter = {
    asOf: localTime(new Date(oldest), shop.businessHours.timezone).dateKey,
    stale,
    synthetic: usable.some(([, ps]) => ps.synthetic),
    pricesShown: false,
    stockShown: shop.stockDisplay !== "hidden",
  };
  if (stale) return { views, footer }; // old data: date + "staff confirm", no quantities
  const showPrice = shop.priceQuotingEnabled;
  for (const [pn, ps] of usable) {
    const view: PartStockView = {
      display: shop.stockDisplay,
      exact: ps.exact ? qtyView(ps.exact, showPrice) : null,
      variants: (shop.showAlternatives ? ps.variants : []).map((v) => ({
        ...qtyView(v, showPrice),
        kind: v.suffixInfo.kind,
        code: v.suffix,
        labelAr: v.suffixInfo.labelAr,
        labelEn: v.suffixInfo.labelEn,
        unconfirmed: v.suffixInfo.unconfirmed,
      })),
    };
    const shown = [view.exact, ...view.variants].filter((q) => q !== null && (view.display !== "hidden" || q.priceSar !== null));
    if (shown.length === 0) continue; // e.g. only alternatives in stock and alternatives are off
    if (shown.some((q) => q && q.priceSar !== null)) footer.pricesShown = true;
    views.set(pn, view);
  }
  if (views.size === 0) return { views, footer: null };
  return { views, footer };
}

// ------------------------------------------------------------------ one turn

class Turn {
  readonly segments: string[] = [];
  /** Template name of each segment (same order), so the AI only rephrases replies made of safe templates. */
  kinds: string[] = [];
  /** The code-rendered parts block inside the partsQuoted segment (kept verbatim when the AI rephrases). */
  partsBlock: string | null = null;
  readonly actions: BotAction[] = [];
  /** AI for this turn (cleared after a provider failure so we do not wait on it twice). */
  ai: EngineAi | undefined;
  /** Catalogue queries from the AI understanding (several parts in one message). */
  aiQueries: PartQuery[] = [];
  customerText = "";
  /** Part numbers we are allowed to say this turn: exact strings from OneEPC, confirmed + unambiguous only. */
  readonly quotable = new Set<string>();
  /** Set when the turn must not change `updatedAt` / `turns` (silent handoff). */
  silent = false;
  lang: Lang;

  constructor(
    public s: ConversationState,
    readonly deps: EngineDeps,
    lang: Lang,
  ) {
    this.lang = lang;
    this.ai = deps.ai;
  }

  say<K extends TemplateName>(name: K, ...p: Parameters<typeof render<K>> extends [Lang, K, ...infer R] ? R : never): void {
    this.segments.push((render as (l: Lang, n: K, ...r: unknown[]) => string)(this.lang, name, ...p));
    this.kinds.push(name);
  }

  followUp(): string {
    return staffFollowUp(this.lang, this.deps.shop, staffAvailability(this.deps.now(), this.deps.shop.businessHours));
  }

  handoff(reason: HandoffReason, template: Extract<TemplateName, `handoff${string}` | "needStaffConfirm" | "capReached">): void {
    this.say(template as "handoffGeneric", { followUp: this.followUp() });
    this.s.step = "handoff";
    this.s.handoffReason = reason;
    this.s.clarification = null;
    this.s.candidates = [];
    this.actions.push({ type: "handoff", reason });
  }
}

// ------------------------------------------------------------------ OneEPC failure mapping

/** Returns true if the failure was fully handled (a reply + state change is queued on the turn). */
function failOneEpc(t: Turn, err: unknown, endpoint: "decode" | "search"): void {
  if (err instanceof OneEpcError) {
    t.actions.push({ type: "oneepc_call", endpoint, requestId: err.requestId, dataVersion: null, outcome: `error:${err.code}` });
    switch (err.code) {
      case "vin_not_found":
        return t.handoff("unknown_vin", "handoffUnknownVin");
      case "unsupported_brand":
        return t.handoff("unsupported_brand", "handoffUnsupportedBrand");
      case "invalid_vin":
        // Our own pre-check should prevent this; treat like a bad VIN once, then hand off.
        t.s.counters.invalidVin++;
        if (t.s.counters.invalidVin >= MAX_INVALID_VIN) return t.handoff("invalid_vin_repeated", "handoffGeneric");
        t.s.step = "awaiting_vin";
        return t.say("invalidVin", { problem: "bad_length" });
      case "missing_query":
      case "invalid_param":
        t.s.step = "awaiting_part";
        return t.say("noResults");
      default: {
        const critical = err.code === "invalid_key" || err.code === "key_revoked" || err.code === "catalog_unavailable";
        t.actions.push({
          type: "alert",
          severity: critical ? "critical" : "warning",
          code: `oneepc_${err.code}`,
          detail: `status=${err.status} endpoint=${endpoint} request_id=${err.requestId ?? "-"}`,
        });
        return t.handoff("oneepc_error", "handoffError");
      }
    }
  }
  t.actions.push({ type: "alert", severity: "critical", code: "engine_exception", detail: `endpoint=${endpoint} error=${(err as Error)?.name ?? "unknown"}` });
  t.handoff("internal_error", "handoffError");
}

// ------------------------------------------------------------------ decode

/** "vehicle_ready": t.s.vehicle is set (freshly decoded). "stopped": the turn already has its reply. */
async function processVin(t: Turn, vin: string): Promise<"vehicle_ready" | "stopped"> {
  const { s } = t;
  s.vin = vin;
  s.vehicle = null;
  s.candidates = [];
  s.clarification = null;
  s.counters.invalidVin = 0;
  s.counters.variantReprompts = 0;
  s.counters.failedSearches = 0;

  let res: OneEpcResult<DecodeResponse>;
  try {
    res = await t.deps.oneepc.decode(vin);
  } catch (err) {
    failOneEpc(t, err, "decode");
    return "stopped";
  }
  const { data } = res;
  t.actions.push({ type: "oneepc_call", endpoint: "decode", requestId: res.requestId, dataVersion: res.dataVersion, outcome: data.match });

  if (data.match === "exact" && data.vehicle) {
    s.vehicle = toRef(data.vehicle, false);
    return "vehicle_ready";
  }
  if (data.match === "ambiguous") {
    const cands = data.candidates.map((c) => toRef(c, false, c.differs_by));
    if (cands.length === 0) {
      t.handoff("unknown_vin", "handoffUnknownVin");
      return "stopped";
    }
    if (cands.length > MAX_VARIANT_OPTIONS) {
      t.handoff("too_many_variants", "handoffTooManyVariants");
      return "stopped";
    }
    s.candidates = cands;
    s.step = "awaiting_variant";
    t.say("variantQuestion", { options: cands.map((c) => candidateLabel(c, t.lang)) });
    return "stopped";
  }
  t.handoff("unknown_vin", "handoffUnknownVin");
  return "stopped";
}

// ------------------------------------------------------------------ search

type SearchOutcome =
  | { kind: "confirmed"; query: string; results: PartResult[]; confirmed: PartResult[] }
  | { kind: "ambiguous"; query: string; question: string | null }
  | { kind: "unconfirmed"; query: string }
  | { kind: "none"; query: string }
  /** OneEPC failed: the turn already holds the handoff reply (failOneEpc). */
  | { kind: "failed"; query: string };

/** One OneEPC search call; an expired vehicle_id is refreshed (decode once more with the stored VIN) and retried once. */
async function searchCall(t: Turn, params: SearchPartsParams): Promise<{ res: OneEpcResult<SearchResponse>; redecoded: boolean }> {
  const { s, deps } = t;
  try {
    return { res: await deps.oneepc.searchParts(s.vehicle!.vehicleId, params), redecoded: false };
  } catch (err) {
    if (err instanceof OneEpcError && err.code === "vehicle_not_found" && s.vin) {
      const d = await deps.oneepc.decode(s.vin);
      if (d.data.match !== "exact" || !d.data.vehicle) throw err;
      s.vehicle = { ...toRef(d.data.vehicle, s.vehicle!.acknowledged) };
      return { res: await deps.oneepc.searchParts(s.vehicle.vehicleId, params), redecoded: true };
    }
    throw err;
  }
}

/** Classify one search response (only confirmed, unambiguous results at MIN_QUOTE_SCORE or more are quotable). */
function outcomeOf(t: Turn, query: string, data: SearchResponse): SearchOutcome {
  const results = data.results.filter((r) => r.score >= MIN_QUOTE_SCORE);
  if (data.ambiguity.is_ambiguous) return { kind: "ambiguous", query, question: pickQuestion(data.ambiguity.question_hint, t.lang) };
  const confirmed = results.filter((r) => r.fitment.status === "confirmed");
  if (confirmed.length > 0) return { kind: "confirmed", query, results, confirmed };
  if (results.length > 0) return { kind: "unconfirmed", query };
  return { kind: "none", query };
}

/** How useful an outcome is when two languages were tried (ties keep the first call). */
const OUTCOME_RANK: Record<SearchOutcome["kind"], number> = { failed: -1, none: 0, unconfirmed: 1, ambiguous: 2, confirmed: 3 };
const topScore = (data: SearchResponse) => data.results.reduce((m, r) => Math.max(m, r.score), 0);

/**
 * One catalogue search for one part, no conversation-state decisions (except refreshing an expired vehicle id).
 * AI path: `q` = the Arabic name and `q_en` = the English name. If that gives nothing quotable, ONE more call with
 * the languages swapped (q = English); the better of the two counts. At most 2 search calls per part.
 * Rules-only path (no AI): Arabic `q` only, one call.
 */
async function searchOnce(t: Turn, query: string): Promise<SearchOutcome> {
  const { s, deps } = t;
  if (!s.vehicle) return { kind: "failed", query };
  const qEn = deps.ai ? (s.partEn[query] ?? null) : null;
  const base = { lang: "auto" as const, limit: 5 };

  let first: { res: OneEpcResult<SearchResponse>; redecoded: boolean };
  try {
    first = await searchCall(t, { ...base, q: query, ...(qEn ? { q_en: qEn } : {}) });
  } catch (err) {
    failOneEpc(t, err, "search");
    return { kind: "failed", query };
  }
  const log = (res: OneEpcResult<SearchResponse>, primary: "ar" | "en") =>
    t.actions.push({ type: "oneepc_call", endpoint: "search", requestId: res.requestId, dataVersion: res.dataVersion, outcome: `q=${primary}${qEn ? "+q_en" : ""} results=${res.data.results.length} ambiguous=${res.data.ambiguity.is_ambiguous}` });
  log(first.res, "ar");
  const o1 = outcomeOf(t, query, first.res.data);
  // Swapped retry only when it can help and the call budget allows (a vehicle refresh already used the second call).
  if (o1.kind === "confirmed" || !qEn || first.redecoded) return o1;

  let second: OneEpcResult<SearchResponse>;
  try {
    second = await deps.oneepc.searchParts(s.vehicle.vehicleId, { ...base, q: qEn, q_en: query });
  } catch {
    // The first answer stands; a failed optional retry is not worth a handoff.
    t.actions.push({ type: "oneepc_call", endpoint: "search", requestId: null, dataVersion: null, outcome: "q=en+q_en failed (first answer kept)" });
    return o1;
  }
  log(second, "en");
  const o2 = outcomeOf(t, query, second.data);
  const r1 = OUTCOME_RANK[o1.kind];
  const r2 = OUTCOME_RANK[o2.kind];
  const better = r2 > r1 || (r2 === r1 && topScore(second.data) > topScore(first.res.data));
  return better ? o2 : o1;
}

/** Quote confirmed results (one partsQuoted segment) and remember them. */
async function quote(t: Turn, shown: PartResult[], staffNote: boolean, query: string): Promise<void> {
  const { s, deps } = t;
  const { views, footer } = await stockForQuote(t, shown.map((r) => r.part_number));
  const showNumbers = deps.shop.showPartNumbers;
  const items: PartLine[] = shown.map((r) => {
    const stock = views.get(r.part_number);
    return { name: partName(r, t.lang), partNumber: showNumbers ? r.part_number : null, ...(stock ? { stock } : {}) };
  });
  // Hidden numbers are never quotable: if one slipped into the text the guard would block the reply.
  if (showNumbers) shown.forEach((r) => t.quotable.add(r.part_number));
  s.lastParts = shown.map((r) => r.part_number);
  s.lastQuery = query;
  t.actions.push({ type: "parts_identified", partNumbers: s.lastParts, shownToCustomer: showNumbers });
  s.step = "awaiting_part";
  s.pendingPart = null;
  s.pendingParts = [];
  s.clarification = null;
  s.counters.failedSearches = 0;
  const params = { items, staffNote, askAck: !(s.vehicle?.acknowledged ?? true), stock: footer };
  t.partsBlock = renderPartsBlock(t.lang, params);
  t.say("partsQuoted", params);
}

function nothingFound(t: Turn): void {
  const { s } = t;
  s.counters.failedSearches++;
  s.pendingPart = null;
  s.pendingParts = [];
  s.clarification = null;
  if (s.counters.failedSearches >= MAX_FAILED_SEARCHES) return t.handoff("no_results", "handoffNoResults");
  s.step = "awaiting_part";
  t.say("noResults");
}

function askClarification(t: Turn, baseQuery: string, question: string, rounds: number): void {
  const { s } = t;
  s.clarification = { baseQuery, question, rounds };
  s.step = "awaiting_clarification";
  s.pendingPart = null;
  s.pendingParts = [];
  t.say("clarification", { question });
}

/** AI (optional): narrow several confirmed results to what was asked, by index only. */
async function aiSelect(t: Turn, query: string, confirmed: PartResult[]): Promise<{ keep: PartResult[] } | { question: string } | null> {
  const ai = t.ai;
  if (!ai || confirmed.length < 2 || !t.customerText) return null;
  const r = await ai.select({
    lang: t.lang,
    customerText: t.customerText,
    query,
    candidates: confirmed.map((c, index) => ({ index, nameAr: c.name.ar, nameEn: c.name.en, category: c.category.ar ?? c.category.en ?? null })),
  });
  t.actions.push({ type: "ai_call", stage: "select", ok: r.ok, reason: r.ok ? null : r.reason, model: r.model, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cachedInputTokens: r.usage.cachedInputTokens ?? 0, ...(r.usage.costUsd !== undefined ? { costUsd: r.usage.costUsd } : {}) });
  if (!r.ok) return null;
  if (r.keep.length > 0) return { keep: [...r.keep].sort((a, b) => a - b).map((i) => confirmed[i]!) };
  return r.question ? { question: r.question } : null;
}

async function runSearch(t: Turn, query: string, clarifyRounds: number, previousQuestion: string | null): Promise<void> {
  const { s, deps } = t;
  if (!s.vehicle) return;
  const o = await searchOnce(t, query);
  switch (o.kind) {
    case "failed":
      return;
    // 1. Ambiguous search: ask the API's own question (never quote anything from an ambiguous response).
    case "ambiguous": {
      const repeated = o.question !== null && o.question === previousQuestion; // the answer did not resolve it: stop looping
      if (o.question && !repeated && clarifyRounds < MAX_CLARIFY_ROUNDS) return askClarification(t, query, o.question, clarifyRounds + 1);
      return t.handoff("clarification_failed", "needStaffConfirm");
    }
    // 2. Quote confirmed results only (the AI may narrow them by index or ask one question).
    case "confirmed": {
      let pick = o.confirmed;
      const sel = await aiSelect(t, query, o.confirmed);
      if (sel && "keep" in sel) pick = sel.keep;
      else if (sel && "question" in sel && clarifyRounds < MAX_CLARIFY_ROUNDS) return askClarification(t, query, sel.question, clarifyRounds + 1);
      return quote(t, pick.slice(0, deps.shop.maxPartsPerReply), o.results.length > o.confirmed.length, query);
    }
    // 3. Results exist but none is confirmed to fit.
    case "unconfirmed":
      return t.handoff("fitment_unconfirmed", "needStaffConfirm");
    // 4. Nothing found.
    case "none":
      return nothingFound(t);
  }
}

/** Display name for a query we could not resolve: never a part-number-like string. */
function queryLabel(q: string, lang: Lang): string {
  return findPartNumberLikeTokens(q).length > 0 ? (lang === "ar" ? "القطعة اللي كتبت رقمها" : "the part number you sent") : q;
}

/**
 * AI path, several parts in one message: one search each, ONE reply. Confirmed ones are quoted together;
 * the first ambiguous one gets the API's question; the rest are named with "please confirm with staff".
 */
async function runMulti(t: Turn, queries: string[]): Promise<void> {
  const { s, deps } = t;
  if (!s.vehicle) return;
  const outcomes: SearchOutcome[] = [];
  for (const q of queries) {
    const o = await searchOnce(t, q);
    if (o.kind === "failed") return;
    outcomes.push(o);
  }
  const confirmed = outcomes.filter((o): o is Extract<SearchOutcome, { kind: "confirmed" }> => o.kind === "confirmed");
  const ask = outcomes.find((o): o is Extract<SearchOutcome, { kind: "ambiguous" }> => o.kind === "ambiguous" && o.question !== null);
  if (confirmed.length === 0 && !ask) {
    if (outcomes.some((o) => o.kind === "unconfirmed" || o.kind === "ambiguous")) return t.handoff("fitment_unconfirmed", "needStaffConfirm");
    return nothingFound(t);
  }
  if (confirmed.length > 0) {
    const shown = confirmed.flatMap((o) => o.confirmed).slice(0, deps.shop.maxPartsPerReply);
    await quote(t, shown, confirmed.some((o) => o.results.length > o.confirmed.length), confirmed[0]!.query);
  }
  const unresolved = outcomes.filter((o) => o.kind !== "confirmed" && o !== ask).map((o) => queryLabel(o.query, t.lang));
  if (unresolved.length > 0) t.say("partsUnresolved", { names: unresolved });
  if (ask) askClarification(t, ask.query, ask.question!, 1);
}

/** Search what the customer asked for: several AI queries at once, or the single pending request. */
async function searchPending(t: Turn): Promise<void> {
  const { s } = t;
  if (!s.pendingPart) return;
  if (s.pendingParts.length > 1 && s.pendingParts[0] === s.pendingPart) return runMulti(t, s.pendingParts);
  return runSearch(t, s.pendingPart, 0, null);
}

/** Remember the request (and, AI path, every part of it). */
function setPending(t: Turn, request: string): void {
  t.s.pendingPart = request;
  const qs = t.aiQueries.map((q) => q.query);
  t.s.pendingParts = qs.length > 1 && qs[0] === request ? qs.slice(0, 5) : [];
}

// ------------------------------------------------------------------ turn logic

async function afterVehicleKnown(t: Turn, fresh: boolean): Promise<void> {
  const { s } = t;
  if (s.pendingPart) {
    if (fresh && s.vehicle) t.say("vehicleLine", { vehicle: vehicleDisplayName(s.vehicle, t.lang) });
    await searchPending(t);
  } else if (s.vehicle) {
    s.step = "awaiting_part";
    if (fresh) t.say("vehicleConfirmAskPart", { vehicle: vehicleDisplayName(s.vehicle, t.lang) });
    else t.say("askPart");
  }
}

/** Idle / awaiting_vin / awaiting_part (and any state where a fresh VIN or request arrives). */
async function handleDefault(t: Turn, p: ParsedMessage, first: boolean): Promise<void> {
  const { s } = t;

  // Reply to the one-line vehicle confirmation.
  if (s.vehicle && !s.vehicle.acknowledged && !p.vin) {
    if (p.isNo) {
      s.vehicle = null;
      s.vin = null;
      s.step = "awaiting_vin";
      t.say("vehicleRejected");
      return;
    }
    s.vehicle.acknowledged = true; // "yes", or asking for a part, counts as acceptance
    if (p.isYes && !p.partRequest && !s.pendingPart) {
      s.step = "awaiting_part";
      t.say("askPart");
      return;
    }
  } else if (s.vehicle && (p.isYes || p.isNo) && !p.partRequest) {
    return void (t.silent = true); // "ok"/"no thanks" after an answer: no message (saves cost, avoids noise)
  }

  if (p.vinProblem && !p.vin) {
    s.counters.invalidVin++;
    if (p.partsVocab && p.partRequest) setPending(t, p.partRequest);
    if (s.counters.invalidVin >= MAX_INVALID_VIN) return t.handoff("invalid_vin_repeated", "handoffGeneric");
    s.step = "awaiting_vin";
    return t.say("invalidVin", { problem: p.vinProblem });
  }

  // "هذا الشاصي <VIN>" must not replace the part the customer already asked for.
  if (p.partRequest && !(p.vin && s.pendingPart && !p.partsVocab)) setPending(t, p.partRequest);

  let fresh = false;
  if (p.vin && !(s.vehicle && s.vin === p.vin)) {
    if ((await processVin(t, p.vin)) === "stopped") return;
    fresh = true;
  }

  if (s.vehicle) return afterVehicleKnown(t, fresh);

  // No vehicle yet: ask for the VIN (remembering the part request).
  s.step = "awaiting_vin";
  if (first) t.say(s.pendingPart ? "welcomeAskVinWithRequest" : "welcomeAskVin", { shopName: t.deps.shop.shopName });
  else t.say(s.pendingPart ? "askVinWithRequest" : "askVin");
}

async function handleVariant(t: Turn, p: ParsedMessage, text: string): Promise<void> {
  const { s } = t;
  if (p.vin) {
    s.candidates = [];
    return handleDefault(t, p, false);
  }
  const idx = parseVariantChoice(text, s.candidates);
  if (idx !== null && s.candidates[idx]) {
    const chosen = s.candidates[idx];
    s.vehicle = { ...chosen, acknowledged: true, differsBy: null };
    s.candidates = [];
    s.counters.variantReprompts = 0;
    s.step = "awaiting_part";
    t.say("vehicleLine", { vehicle: vehicleDisplayName(s.vehicle, t.lang) });
    if (s.pendingPart) return searchPending(t);
    // vehicleLine + askPart share one message.
    t.segments.pop();
    t.kinds.pop();
    t.segments.push(`🚗 ${vehicleDisplayName(s.vehicle, t.lang)}\n${render(t.lang, "askPart")}`);
    t.kinds.push("vehicleLineAskPart");
    return;
  }
  if (p.partsVocab && p.partRequest) setPending(t, p.partRequest);
  s.counters.variantReprompts++;
  if (s.counters.variantReprompts > MAX_VARIANT_REPROMPTS) return t.handoff("variant_unclear", "handoffGeneric");
  t.say("variantReask", { options: s.candidates.map((c) => candidateLabel(c, t.lang)) });
}

async function handleClarification(t: Turn, p: ParsedMessage): Promise<void> {
  const { s } = t;
  const c = s.clarification;
  if (p.vin || !c) return handleDefault(t, p, false);
  if (s.vehicle) s.vehicle.acknowledged = true;
  const isNewRequest = p.partsVocab && p.partRequest;
  const answer = p.partRequest;
  if (!answer || p.isYes || p.isNo) {
    if (c.rounds >= MAX_CLARIFY_ROUNDS) return t.handoff("clarification_failed", "needStaffConfirm");
    s.clarification = { ...c, rounds: c.rounds + 1 };
    return t.say("clarification", { question: c.question });
  }
  if (isNewRequest) {
    setPending(t, answer);
    return searchPending(t);
  }
  return runSearch(t, `${c.baseQuery} ${answer}`.trim(), c.rounds, c.question);
}

// ------------------------------------------------------------------ public entry

export async function handleInbound(state: ConversationState | null, inboundText: string | null, deps: EngineDeps): Promise<EngineResult> {
  const now = deps.now();
  let s = state ? structuredClone(state) : newState(now);
  if (state && isExpired(s, now, deps.shop)) s = resetState(s, now);
  const today = localTime(now, deps.shop.businessHours.timezone).dateKey;

  const text = (inboundText ?? "").trim();
  let parsed: ParsedMessage | null = text
    ? parseMessage(text, { modelHints: s.vehicle ? [s.vehicle.modelAr, s.vehicle.modelEn].filter((x): x is string => !!x) : [] })
    : null;
  // The synonym list (deterministic, admin-owned) runs on the rule parser's request too.
  if (parsed?.partRequest && deps.synonyms) {
    const rw = deps.synonyms.rewrite(parsed.partRequest);
    if (rw.hits.length > 0) parsed = { ...parsed, partRequest: rw.text, partsVocab: true };
  }
  const lang: Lang = deps.shop.language === "auto" ? (parsed?.lang ?? s.lang) : deps.shop.language;
  s.lang = lang;
  const t = new Turn(s, deps, lang);
  t.customerText = text;
  if (!aiWorthCalling(t, parsed, text)) t.ai = undefined;
  const first = s.turns === 0;

  if (t.ai && parsed && !rulesAreEnough(s, parsed, text)) {
    const u = await t.ai.understand({
      text,
      history: s.history,
      vehicle: s.vehicle ? vehicleDisplayName(s.vehicle, "en") : null,
      language: deps.shop.language,
      waitingFor: waitingFor(s),
      lastPart: s.lastQuery ?? s.pendingPart,
    });
    t.actions.push({
      type: "ai_call", stage: "understand", ok: u.ok, reason: u.ok ? null : u.reason, model: u.model, latencyMs: u.latencyMs,
      inputTokens: u.usage.inputTokens, outputTokens: u.usage.outputTokens, cachedInputTokens: u.usage.cachedInputTokens ?? 0, ...(u.usage.costUsd !== undefined ? { costUsd: u.usage.costUsd } : {}),
      ...(u.ok ? { intent: u.data.intent, parts: u.data.parts.length } : {}),
    });
    if (u.ok) {
      parsed = mergeUnderstanding(t, parsed, u.data);
    } else if (u.reason !== "schema_invalid" && u.reason !== "invented_part_number") {
      t.ai = undefined; // provider trouble (timeout, overload, auth...): rules + templates for the rest of this turn
    }
  }

  try {
    await decide(t, parsed, text, first, today);
    if (t.ai) await composeTurn(t);
  } catch (err) {
    t.segments.length = 0;
    t.kinds = [];
    t.quotable.clear();
    t.silent = false;
    failOneEpc(t, err, "search");
  }
  const result = finalize(t, now);
  rememberHistory(result, deps, text);
  return result;
}

// ------------------------------------------------------------------ AI glue

/** Do not spend an AI call when the bot will stay silent / send a fixed note, or the rules are certain. */
function aiWorthCalling(t: Turn, p: ParsedMessage | null, text: string): boolean {
  const { s, deps } = t;
  if (!t.ai || !p || !text) return false;
  if (s.step === "handoff") return false;
  if (deps.botMessagesToday >= deps.shop.maxBotMessagesPerDay) return false;
  if (closedPeriodKey(deps.now(), deps.shop.businessHours) && deps.shop.afterHoursMode === "note_only") return false;
  if (p.wantsRestart) return false;
  return true;
}

/** True when the rules alone are certain (VIN-only message, a bare yes/no, a variant number): skip "understand". */
function rulesAreEnough(s: ConversationState, p: ParsedMessage, text: string): boolean {
  if (p.vin && extractVin(text).rest.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return true;
  if ((p.isYes || p.isNo) && !p.partRequest && text.length <= 15) return true;
  if (s.step === "awaiting_variant" && parseVariantChoice(text, s.candidates) !== null) return true;
  return false;
}

function waitingFor(s: ConversationState): string | null {
  switch (s.step) {
    case "awaiting_vin":
      return s.pendingPart ? `the VIN (chassis number), to search: ${s.pendingPart}` : "the VIN (chassis number) and the part";
    case "awaiting_variant":
      return "the customer to pick one numbered vehicle option";
    case "awaiting_part":
      return "the name of the part the customer needs";
    case "awaiting_clarification":
      return s.clarification ? `an answer to the catalogue question "${s.clarification.question}" about: ${s.clarification.baseQuery}` : null;
    default:
      return null;
  }
}

/**
 * AI understanding -> the ParsedMessage the existing engine already handles. The rules keep the last word on
 * what they are certain about (VIN regex, yes/no, restart); the synonym list beats the model's part names.
 */
function mergeUnderstanding(t: Turn, rule: ParsedMessage, u: Understanding): ParsedMessage {
  const { s, deps } = t;
  const aiVin = !rule.vin && u.vin_or_frame ? extractVin(u.vin_or_frame).vin : null; // code validates the VIN
  const vin = rule.vin ?? aiVin;
  const queries = u.parts.map((part) => queryForAiPart(part, deps.synonyms ?? null));
  for (const q of queries) {
    if (q.suggestion) t.actions.push({ type: "synonym_suggestion", ...q.suggestion });
  }
  t.aiQueries = queries;
  if (queries.length > 0) {
    // English names for the queries of this message (plus the last quoted one, for "بكم؟").
    const keep = s.lastQuery && s.partEn[s.lastQuery] ? { [s.lastQuery]: s.partEn[s.lastQuery]! } : {};
    s.partEn = { ...keep, ...Object.fromEntries(queries.filter((q) => q.queryEn).slice(0, 5).map((q) => [q.query, q.queryEn!])) };
  }
  let partRequest: string | null = queries[0]?.query ?? null;
  let partsVocab = queries.length > 0;
  // "بكم؟" / "متوفر؟" with no part named: the last quoted part again (stock and price come from the quote).
  if (!partRequest && (u.intent === "price" || u.intent === "stock") && s.lastQuery && s.vehicle) partRequest = s.lastQuery;
  if (s.step === "awaiting_clarification" || s.step === "awaiting_variant") {
    // Short answers to our own question ("17 انش", "الثاني"): the rules' text, unless a new part is clearly named.
    partsVocab = rule.partsVocab || queries.some((q) => q.source === "table");
    if (!partsVocab) partRequest = rule.partRequest ?? partRequest;
  }
  const noPart = queries.length === 0;
  return {
    ...rule,
    vin,
    vinProblem: vin ? null : rule.vinProblem,
    partRequest,
    partsVocab,
    isGreeting: rule.isGreeting || u.intent === "greeting",
    isThanks: u.intent === "thanks" && noPart && !vin,
    wantsStaff: rule.wantsStaff || u.intent === "human",
    offTopic: u.intent === "off_topic" && noPart && !vin,
  };
}

/** Segments the AI may rephrase: plain templates without API text, options lists or handoff wording. */
const COMPOSE_KINDS = new Set<string>([
  "welcomeAskVin", "welcomeAskVinWithRequest", "askVin", "askVinWithRequest", "invalidVin", "vehicleConfirmAskPart",
  "vehicleLine", "vehicleLineAskPart", "askPart", "partsQuoted", "partsUnresolved", "noResults", "offTopic", "vehicleRejected",
]);

/** AI (optional): rephrase the decided reply in natural Gulf Arabic / English. Template on any problem. */
async function composeTurn(t: Turn): Promise<void> {
  const ai = t.ai;
  if (!ai || t.silent || t.segments.length === 0) return;
  if (t.actions.some((a) => a.type === "handoff")) return;
  if (!t.kinds.every((k) => COMPOSE_KINDS.has(k))) return;
  let draft = t.segments.join("\n\n");
  if (t.partsBlock) {
    if (draft.split(t.partsBlock).length !== 2) return;
    draft = draft.split(t.partsBlock).join(PARTS_PLACEHOLDER);
  }
  const r = await ai.compose({ lang: t.lang, shopName: t.deps.shop.shopName, customerText: t.customerText, draft });
  t.actions.push({
    type: "ai_call", stage: "compose", ok: r.ok, reason: r.ok ? null : r.reason, model: r.model, latencyMs: r.latencyMs,
    inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cachedInputTokens: r.usage.cachedInputTokens ?? 0, ...(r.usage.costUsd !== undefined ? { costUsd: r.usage.costUsd } : {}), validator: r.ok ? "pass" : r.validator,
  });
  if (!r.ok) return;
  const final = t.partsBlock ? r.text.split(PARTS_PLACEHOLDER).join(t.partsBlock) : r.text;
  t.segments.length = 0;
  t.segments.push(final);
  t.kinds = ["composed"];
}

/** AI shops keep a short, truncated history for follow-ups; other shops keep none. */
function rememberHistory(result: EngineResult, deps: EngineDeps, text: string): void {
  const st = result.newState;
  if (!deps.ai) {
    st.history = [];
    return;
  }
  if (st.turns === 0 && st.step === "idle" && !text) return;
  const cut = (x: string) => (x.length > HISTORY_TEXT_MAX ? `${x.slice(0, HISTORY_TEXT_MAX - 1)}…` : x);
  const add: ConversationState["history"] = [];
  if (text) add.push({ from: "customer", text: cut(text) });
  for (const r of result.replies) add.push({ from: "bot", text: cut(r) });
  st.history = [...st.history, ...add].slice(-HISTORY_MAX);
}

async function decide(t: Turn, p: ParsedMessage | null, text: string, first: boolean, today: string): Promise<void> {
  const { s, deps } = t;

  // Silent while staff handle the chat (until the silence window ends, see isExpired), unless asked to restart.
  if (s.step === "handoff") {
    if (p?.wantsRestart) {
      Object.assign(s, resetState(s, deps.now()));
      return t.say("restart");
    }
    t.actions.push({ type: "customer_waiting" });
    t.silent = true;
    return;
  }

  // Daily cap: one final handoff message, then silence for the rest of the day.
  if (deps.botMessagesToday >= deps.shop.maxBotMessagesPerDay) {
    if (s.capNotifiedDay === today) {
      t.actions.push({ type: "customer_waiting" });
      t.silent = true;
      return;
    }
    s.capNotifiedDay = today;
    t.actions.push({ type: "alert", severity: "warning", code: "daily_cap_reached", detail: `cap=${deps.shop.maxBotMessagesPerDay}` });
    return t.handoff("daily_cap", "capReached");
  }

  // After hours, note-only shops: one note per closed period, then wait silently for staff. No OneEPC call.
  const closed = closedPeriodKey(deps.now(), deps.shop.businessHours);
  if (closed && deps.shop.afterHoursMode === "note_only") {
    t.actions.push({ type: "customer_waiting" });
    if (s.afterHoursNoticeFor === closed) return void (t.silent = true);
    s.afterHoursNoticeFor = closed;
    return t.say("afterHoursOnly", { when: nextOpeningText(t), shopName: deps.shop.shopName });
  }

  if (!p) return t.say("nonText");
  if (p.wantsRestart) {
    Object.assign(s, resetState(s, deps.now()));
    return t.say("restart");
  }
  if (p.wantsStaff) return t.handoff("customer_request", "handoffRequested");
  if (p.offTopic) {
    s.counters.offTopic++;
    if (s.counters.offTopic >= MAX_OFF_TOPIC) return t.handoff("off_topic_repeated", "handoffGeneric");
    return t.say("offTopic");
  }
  if (p.isThanks) return void (t.silent = true);

  switch (s.step) {
    case "awaiting_variant":
      return handleVariant(t, p, text);
    case "awaiting_clarification":
      return handleClarification(t, p);
    default:
      return handleDefault(t, p, first);
  }
}

function nextOpeningText(t: Turn): string {
  const a = staffAvailability(t.deps.now(), t.deps.shop.businessHours);
  return !a.open && a.next ? whenText(t.lang, a.next) : "";
}

/** reply_with_note: add the closed-now note once per closed period; handoff replies already say when staff answer. */
function addAfterHoursNote(t: Turn): void {
  const { s, deps } = t;
  if (deps.shop.afterHoursMode !== "reply_with_note" || t.segments.length === 0) return;
  if (t.actions.some((a) => a.type === "handoff")) return;
  const closed = closedPeriodKey(deps.now(), deps.shop.businessHours);
  if (!closed || s.afterHoursNoticeFor === closed) return;
  s.afterHoursNoticeFor = closed;
  t.say("afterHoursNote", { when: nextOpeningText(t) });
}

function finalize(t: Turn, now: Date): EngineResult {
  const { s, deps } = t;
  addAfterHoursNote(t);
  let reply = t.segments.join("\n\n");
  if (reply) {
    try {
      assertOnlyAllowedPartNumbers(reply, {
        allowed: t.quotable,
        ignore: [deps.shop.staffHandoffPhone, ...vehicleTokens(s.vehicle, s.candidates)],
      });
    } catch (err) {
      if (!(err instanceof PartNumberGuardError)) throw err;
      // Never send it. Replace with a safe handoff message and tell ops (offending tokens are logged as a count only).
      t.segments.length = 0;
      t.quotable.clear();
      t.actions.push({ type: "alert", severity: "critical", code: "part_number_guard_blocked", detail: `tokens=${err.offending.length}` });
      t.handoff("guard_blocked", "handoffError");
      reply = t.segments.join("\n\n");
    }
  }
  if (!t.silent) {
    s.turns++;
    s.updatedAt = now.toISOString();
  }
  return { newState: s, replies: reply ? [reply] : [], actions: t.actions };
}
