/**
 * Consumes one `inbound-message` job: load state -> engine -> send replies -> save state -> usage counters.
 * All I/O (store, OneEPC, WhatsApp sender, clock, logger) is injected, so it runs in tests with fakes.
 *
 * DRY_RUN (default true): nothing is sent; we log reply ids and lengths only.
 * PDPL: logs carry ids, counts and codes. Never message text, never phone numbers.
 */
import type { InboundMessageJob } from "../zernio/types.js";
import type { SendOptions, SendTarget } from "../zernio/send.js";
import { handleInbound, type BotAction, type OneEpcLike } from "./engine.js";
import { shopConfigSchema, localTime } from "./shop-config.js";
import { STATE_RETENTION_DAYS, type BotStore } from "./store.js";
import { createStockLookup, syntheticAllowed, type StockSource } from "../inventory/stock.js";
import type { EngineAi } from "../ai/index.js";
import { costUsd } from "../ai/provider.js";
import type { SuggestionInput, SynonymIndex } from "../ai/synonyms.js";

/** The slice of ZernioSender we use. */
export interface ReplySender {
  sendText(target: SendTarget, body: string, opts: SendOptions): Promise<unknown>;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface WorkerHandlerDeps {
  store: BotStore;
  oneepc: OneEpcLike;
  /** Per-shop catalog client (real vs mock routing). When set, it wins over `oneepc`. */
  oneepcFor?: (shop: { testShop: boolean }) => OneEpcLike;
  /** Null is allowed only with dryRun. */
  sender: ReplySender | null;
  dryRun: boolean;
  /** Shop stock (inventory_items). Absent = replies never mention stock. */
  stock?: StockSource;
  /** Env ALLOW_SYNTHETIC_STOCK=true: a test shop may see synthetic stock. Never applies to a real shop. */
  allowSyntheticStockEnv?: boolean;
  /** Server-wide AI (AI_ENABLED + key). Used only for shops with `aiEnabled`. Absent = rules only. */
  ai?: EngineAi;
  /** AI per provider name (only providers with a key); a shop's `aiProvider` setting picks one, else `ai`. */
  aiByProvider?: Record<string, EngineAi>;
  /** The synonym list (cached). A load failure = no synonyms this turn + an alert. */
  synonyms?: () => Promise<SynonymIndex>;
  /** Store the AI's unknown mappings as pending suggestions (best effort). */
  recordSuggestions?: (s: SuggestionInput[]) => Promise<void>;
  now?: () => Date;
  log?: (event: string, fields?: LogFields) => void;
}

export type JobOutcome =
  | "replied"
  | "silent"
  | "duplicate"
  | "skipped_standby"
  | "skipped_test"
  | "skipped_no_shop"
  | "skipped_bad_config";

const defaultLog = (event: string, fields: LogFields = {}) =>
  console.log(JSON.stringify({ event, ...fields }));

export async function processInboundJob(job: InboundMessageJob, deps: WorkerHandlerDeps): Promise<JobOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;
  const ids = { providerMessageId: job.providerMessageId, conversationId: job.conversationId };

  // Another app owns the chat: replying would take control back. Test webhooks never get a reply.
  if (job.standby) {
    log("job_skipped", { ...ids, reason: "standby" });
    return "skipped_standby";
  }
  if (job.isTest) {
    log("job_skipped", { ...ids, reason: "test_event" });
    return "skipped_test";
  }

  const shop = await deps.store.resolveShop(job.accountId);
  if (!shop) {
    // Not retried: the job would fail forever. Surfaces in logs; onboarding must create the shops row.
    log("job_skipped", { ...ids, reason: "no_shop_for_account", accountId: job.accountId });
    return "skipped_no_shop";
  }
  // The admin CLI validates before writing, so this only trips on a hand-edited row. Never guess settings
  // (a default could show what the shop hid): no reply, an ops alert naming the bad keys (not their values).
  const parsedConfig = shopConfigSchema.safeParse(shop.config ?? {});
  if (!parsedConfig.success) {
    const keys = [...new Set(parsedConfig.error.issues.map((i) => i.path.join(".") || "(root)"))].join(",");
    log("alert", { ...ids, severity: "critical", code: "shop_config_invalid", detail: `shop=${shop.id} keys=${keys}` });
    return "skipped_bad_config";
  }
  const shopConfig = parsedConfig.data;

  return deps.store.withLock(shop.id, job.conversationId, async () => {
    const at = now();
    const dayKey = localTime(at, shopConfig.businessHours.timezone).dateKey;
    const state = await deps.store.getState(shop.id, job.conversationId, at);

    // A replayed job (retry after a crash between send and save) must not run twice.
    if (state?.lastMessageId === job.providerMessageId) {
      log("job_duplicate", ids);
      return "duplicate";
    }

    const botMessagesToday = await deps.store.getBotMessagesToday(shop.id, dayKey);
    const allowSynthetic = syntheticAllowed({
      testShop: shopConfig.testShop,
      allowSyntheticStock: shopConfig.allowSyntheticStock,
      envAllowSynthetic: deps.allowSyntheticStockEnv === true,
    });
    const stock = deps.stock ? createStockLookup(deps.stock, shop.id, allowSynthetic) : undefined;
    const oneepc = deps.oneepcFor ? deps.oneepcFor({ testShop: shopConfig.testShop }) : deps.oneepc;
    let synonyms: SynonymIndex | undefined;
    if (deps.synonyms) {
      try {
        synonyms = await deps.synonyms();
      } catch (err) {
        log("alert", { ...ids, severity: "warning", code: "synonyms_load_failed", detail: `error=${(err as Error)?.name ?? "unknown"}` });
      }
    }
    let ai: EngineAi | undefined;
    if (deps.ai && shopConfig.aiEnabled) {
      ai = deps.ai;
      if (shopConfig.aiProvider !== "server_default") {
        const chosen = deps.aiByProvider?.[shopConfig.aiProvider];
        if (chosen) ai = chosen;
        else log("alert", { ...ids, severity: "warning", code: "ai_provider_unavailable", detail: `provider=${shopConfig.aiProvider} (no key): server default used` });
      }
    }
    const result = await handleInbound(state, job.text, {
      oneepc, now, shop: shopConfig, botMessagesToday, stock, allowSyntheticStock: allowSynthetic,
      ...(ai ? { ai } : {}), ...(synonyms ? { synonyms } : {}),
    });
    result.newState.lastMessageId = job.providerMessageId;

    logActions(log, ids, result.actions);

    // Send first, save after: if sending throws, pg-boss retries and the engine re-runs from the old state.
    // Idempotency keys make a repeated send a no-op at Zernio.
    for (const [i, body] of result.replies.entries()) {
      if (deps.dryRun || !deps.sender) {
        if (!deps.dryRun) throw new Error("no WhatsApp sender configured and DRY_RUN is off");
        log("dry_run_reply", { ...ids, index: i, length: body.length, step: result.newState.step });
      } else {
        await deps.sender.sendText(
          { conversationId: job.conversationId, accountId: job.accountId },
          body,
          { idempotencyKey: `${job.providerMessageId}:${i}` },
        );
        log("reply_sent", { ...ids, index: i, length: body.length, step: result.newState.step });
      }
    }

    const retentionUntil = new Date(at.getTime() + STATE_RETENTION_DAYS * 24 * 3600 * 1000);
    await deps.store.saveState(shop.id, job.conversationId, result.newState, retentionUntil);
    if (result.replies.length > 0 || state === null) {
      await deps.store.addUsage(shop.id, dayKey, { botMessages: result.replies.length, newConversations: state === null ? 1 : 0 });
    }
    const suggestions = result.actions.flatMap((a) => (a.type === "synonym_suggestion" ? [{ term: a.term, canonicalAr: a.canonicalAr, canonicalEn: a.canonicalEn }] : []));
    if (suggestions.length > 0 && deps.recordSuggestions) {
      await deps.recordSuggestions(suggestions).catch((err: unknown) =>
        log("alert", { ...ids, severity: "warning", code: "synonym_suggestion_failed", detail: `error=${(err as Error)?.name ?? "unknown"}` }),
      );
    }
    return result.replies.length > 0 ? "replied" : "silent";
  });
}

function logActions(log: NonNullable<WorkerHandlerDeps["log"]>, ids: LogFields, actions: BotAction[]): void {
  const suggestions = actions.filter((a) => a.type === "synonym_suggestion").length;
  if (suggestions > 0) log("synonym_suggestions", { ...ids, count: suggestions });
  for (const a of actions) {
    switch (a.type) {
      case "handoff":
        log("handoff", { ...ids, reason: a.reason }); // TODO: notify staff (not built yet)
        break;
      case "alert":
        log("alert", { ...ids, severity: a.severity, code: a.code, detail: a.detail }); // TODO: page ops
        break;
      case "customer_waiting":
        log("customer_waiting", ids);
        break;
      case "parts_identified":
        // Part numbers are catalogue data (not personal data); logged even when hidden from the customer.
        log("parts_identified", { ...ids, partNumbers: a.partNumbers.join(","), shownToCustomer: a.shownToCustomer });
        break;
      case "oneepc_call":
        log("oneepc_call", { ...ids, endpoint: a.endpoint, requestId: a.requestId, dataVersion: a.dataVersion, outcome: a.outcome });
        break;
      case "ai_call":
        // Metrics only: never the prompt, the customer's message or the reply.
        log("ai_call", {
          ...ids, stage: a.stage, ok: a.ok, reason: a.reason, model: a.model, latencyMs: a.latencyMs,
          inputTokens: a.inputTokens, outputTokens: a.outputTokens, cachedInputTokens: a.cachedInputTokens ?? 0,
          costUsd: ((c) => (c === null ? null : Number(c.toFixed(6))))(costUsd(a.model, { inputTokens: a.inputTokens, outputTokens: a.outputTokens, cachedInputTokens: a.cachedInputTokens ?? 0 }, new Date())),
          intent: a.intent, parts: a.parts, validator: a.validator,
        });
        break;
      case "synonym_suggestion":
        break; // counted below; the words themselves go to the admin's review list, not to logs
    }
  }
}
