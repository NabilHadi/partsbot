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
 *  4. No prices, no stock (not in this step).
 *  5. At the daily cap: ONE final handoff message, then silence.
 */
import { OneEpcError } from "../oneepc/errors.js";
import type { DecodeResponse, PartResult, SearchResponse, Vehicle, VehicleCandidate } from "../oneepc/types.js";
import type { OneEpcResult, SearchPartsParams } from "../oneepc/client.js";
import { PartNumberGuardError, assertOnlyAllowedPartNumbers } from "./guard.js";
import { parseMessage, parseVariantChoice, type Lang, type ParsedMessage } from "./intent.js";
import { T, render, staffFollowUp, type PartLine, type TemplateName } from "./arabic.js";
import { localTime, staffAvailability, type ShopConfig } from "./shop-config.js";
import { isExpired, newState, resetState, vehicleDisplayName, type ConversationState, type VehicleRef } from "./state.js";

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
  /** One line per OneEPC call, for logs (request id + data version only). */
  | { type: "oneepc_call"; endpoint: "decode" | "search"; requestId: string | null; dataVersion: string | null; outcome: string };

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

// ------------------------------------------------------------------ one turn

class Turn {
  readonly segments: string[] = [];
  readonly actions: BotAction[] = [];
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
  }

  say<K extends TemplateName>(name: K, ...p: Parameters<typeof render<K>> extends [Lang, K, ...infer R] ? R : never): void {
    this.segments.push((render as (l: Lang, n: K, ...r: unknown[]) => string)(this.lang, name, ...p));
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
        const critical = err.code === "invalid_key" || err.code === "key_revoked";
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

async function runSearch(t: Turn, query: string, clarifyRounds: number, previousQuestion: string | null): Promise<void> {
  const { s, deps } = t;
  const vehicle = s.vehicle;
  if (!vehicle) return;

  let res: OneEpcResult<SearchResponse>;
  try {
    try {
      res = await deps.oneepc.searchParts(vehicle.vehicleId, { q: query, lang: "auto", limit: 5 });
    } catch (err) {
      // vehicle_id expired between decode and search: decode once more with the stored VIN, then retry once.
      if (err instanceof OneEpcError && err.code === "vehicle_not_found" && s.vin) {
        const d = await deps.oneepc.decode(s.vin);
        if (d.data.match !== "exact" || !d.data.vehicle) throw err;
        s.vehicle = { ...toRef(d.data.vehicle, vehicle.acknowledged) };
        res = await deps.oneepc.searchParts(s.vehicle.vehicleId, { q: query, lang: "auto", limit: 5 });
      } else {
        throw err;
      }
    }
  } catch (err) {
    failOneEpc(t, err, "search");
    return;
  }
  const { data } = res;
  const results = data.results.filter((r) => r.score >= MIN_QUOTE_SCORE);
  t.actions.push({ type: "oneepc_call", endpoint: "search", requestId: res.requestId, dataVersion: res.dataVersion, outcome: `results=${data.results.length} ambiguous=${data.ambiguity.is_ambiguous}` });

  // 1. Ambiguous search: ask the API's own question (never quote anything from an ambiguous response).
  if (data.ambiguity.is_ambiguous) {
    const question = pickQuestion(data.ambiguity.question_hint, t.lang);
    const repeated = question !== null && question === previousQuestion; // the answer did not resolve it: stop looping
    if (question && !repeated && clarifyRounds < MAX_CLARIFY_ROUNDS) {
      s.clarification = { baseQuery: query, question, rounds: clarifyRounds + 1 };
      s.step = "awaiting_clarification";
      s.pendingPart = null;
      t.say("clarification", { question });
      return;
    }
    t.handoff("clarification_failed", "needStaffConfirm");
    return;
  }

  // 2. Quote confirmed results only.
  const confirmed = results.filter((r) => r.fitment.status === "confirmed");
  if (confirmed.length > 0) {
    const shown = confirmed.slice(0, deps.shop.maxPartsPerReply);
    const items: PartLine[] = shown.map((r) => ({ name: partName(r, t.lang), partNumber: r.part_number }));
    shown.forEach((r) => t.quotable.add(r.part_number));
    s.step = "awaiting_part";
    s.pendingPart = null;
    s.clarification = null;
    s.counters.failedSearches = 0;
    t.say("partsQuoted", { items, staffNote: results.length > confirmed.length, askAck: !vehicle.acknowledged });
    return;
  }

  // 3. Results exist but none is confirmed to fit.
  if (results.length > 0) {
    t.handoff("fitment_unconfirmed", "needStaffConfirm");
    return;
  }

  // 4. Nothing found.
  s.counters.failedSearches++;
  s.pendingPart = null;
  s.clarification = null;
  if (s.counters.failedSearches >= MAX_FAILED_SEARCHES) {
    t.handoff("no_results", "handoffNoResults");
    return;
  }
  s.step = "awaiting_part";
  t.say("noResults");
}

// ------------------------------------------------------------------ turn logic

async function afterVehicleKnown(t: Turn, fresh: boolean): Promise<void> {
  const { s } = t;
  if (s.pendingPart) {
    if (fresh && s.vehicle) t.say("vehicleLine", { vehicle: vehicleDisplayName(s.vehicle, t.lang) });
    await runSearch(t, s.pendingPart, 0, null);
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
    if (p.partsVocab && p.partRequest) s.pendingPart = p.partRequest;
    if (s.counters.invalidVin >= MAX_INVALID_VIN) return t.handoff("invalid_vin_repeated", "handoffGeneric");
    s.step = "awaiting_vin";
    return t.say("invalidVin", { problem: p.vinProblem });
  }

  // "هذا الشاصي <VIN>" must not replace the part the customer already asked for.
  if (p.partRequest && !(p.vin && s.pendingPart && !p.partsVocab)) s.pendingPart = p.partRequest;

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
    if (s.pendingPart) return runSearch(t, s.pendingPart, 0, null);
    // vehicleLine + askPart share one message.
    t.segments.pop();
    t.segments.push(`🚗 ${vehicleDisplayName(s.vehicle, t.lang)}\n${render(t.lang, "askPart")}`);
    return;
  }
  if (p.partsVocab && p.partRequest) s.pendingPart = p.partRequest;
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
  if (isNewRequest) return runSearch(t, answer, 0, null);
  return runSearch(t, `${c.baseQuery} ${answer}`.trim(), c.rounds, c.question);
}

// ------------------------------------------------------------------ public entry

export async function handleInbound(state: ConversationState | null, inboundText: string | null, deps: EngineDeps): Promise<EngineResult> {
  const now = deps.now();
  let s = state ? structuredClone(state) : newState(now);
  if (state && isExpired(s, now, deps.shop)) s = resetState(s, now);
  const today = localTime(now, deps.shop.businessHours.timezone).dateKey;

  const text = (inboundText ?? "").trim();
  const parsed: ParsedMessage | null = text
    ? parseMessage(text, { modelHints: s.vehicle ? [s.vehicle.modelAr, s.vehicle.modelEn].filter((x): x is string => !!x) : [] })
    : null;
  const lang: Lang = deps.shop.language === "auto" ? (parsed?.lang ?? s.lang) : deps.shop.language;
  s.lang = lang;
  const t = new Turn(s, deps, lang);
  const first = s.turns === 0;

  try {
    await decide(t, parsed, text, first, today);
  } catch (err) {
    t.segments.length = 0;
    t.quotable.clear();
    t.silent = false;
    failOneEpc(t, err, "search");
  }
  return finalize(t, now);
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

function finalize(t: Turn, now: Date): EngineResult {
  const { s, deps } = t;
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
