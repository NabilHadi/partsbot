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
import { parseShopConfig, localTime } from "./shop-config.js";
import { STATE_RETENTION_DAYS, type BotStore } from "./store.js";
import { createStockLookup, syntheticAllowed, type StockSource } from "../inventory/stock.js";

/** The slice of ZernioSender we use. */
export interface ReplySender {
  sendText(target: SendTarget, body: string, opts: SendOptions): Promise<unknown>;
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface WorkerHandlerDeps {
  store: BotStore;
  oneepc: OneEpcLike;
  /** Null is allowed only with dryRun. */
  sender: ReplySender | null;
  dryRun: boolean;
  /** Shop stock (inventory_items). Absent = replies never mention stock. */
  stock?: StockSource;
  /** Env ALLOW_SYNTHETIC_STOCK=true: a test shop may see synthetic stock. Never applies to a real shop. */
  allowSyntheticStockEnv?: boolean;
  now?: () => Date;
  log?: (event: string, fields?: LogFields) => void;
}

export type JobOutcome =
  | "replied"
  | "silent"
  | "duplicate"
  | "skipped_standby"
  | "skipped_test"
  | "skipped_no_shop";

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
  const shopConfig = parseShopConfig(shop.config);

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
    const result = await handleInbound(state, job.text, { oneepc: deps.oneepc, now, shop: shopConfig, botMessagesToday, stock, allowSyntheticStock: allowSynthetic });
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
    return result.replies.length > 0 ? "replied" : "silent";
  });
}

function logActions(log: NonNullable<WorkerHandlerDeps["log"]>, ids: LogFields, actions: BotAction[]): void {
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
      case "oneepc_call":
        log("oneepc_call", { ...ids, endpoint: a.endpoint, requestId: a.requestId, dataVersion: a.dataVersion, outcome: a.outcome });
        break;
    }
  }
}
