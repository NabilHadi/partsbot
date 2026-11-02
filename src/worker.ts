import PgBoss from "pg-boss";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { oneEpcRoutingFromConfig } from "./oneepc/index.js";
import { QUEUES } from "./queues.js";
import { PgBotStore } from "./bot/store.js";
import { PgStockSource } from "./inventory/stock.js";
import { processInboundJob, type ReplySender } from "./bot/worker-handler.js";
import { createZernioSender } from "./zernio/send.js";
import type { InboundMessageJob } from "./zernio/types.js";
import { createAiFromConfig, engineAi, type EngineAi } from "./ai/index.js";
import { pruneAiAttempts, recordAiAttempt } from "./ai/attempt-repo.js";
import { cachedSynonymIndex, recordSuggestion } from "./ai/synonym-repo.js";

const config = loadConfig();
const dryRun = config.DRY_RUN;
let sender: ReplySender | null = null;
if (!dryRun) {
  if (!config.ZERNIO_API_KEY) throw new Error("DRY_RUN is off but ZERNIO_API_KEY is not set");
  sender = createZernioSender(config.ZERNIO_API_KEY);
}

const db = createPool(config.DATABASE_URL);
const store = new PgBotStore(db);
const stock = new PgStockSource(db);
// decode/search go to the real API or the mock per ONEEPC_*_SOURCE; mock is served to test shops only.
const oneepc = oneEpcRoutingFromConfig(config);

// AI: server-wide switch + key; each shop still needs `aiEnabled` (admin). Off = rules + templates only.
// Every model attempt goes to ai_attempts (codes + numbers only) for the /admin/app health. Best effort.
let attemptLogFailed = false;
const aiSetup = createAiFromConfig(config, (e) => {
  recordAiAttempt(db, e).catch((err: unknown) => {
    if (attemptLogFailed) return;
    attemptLogFailed = true;
    console.log(JSON.stringify({ event: "alert", severity: "warning", code: "ai_attempt_log_failed", detail: `error=${(err as Error)?.name ?? "unknown"}` }));
  });
});
const ai = aiSetup.enabled ? engineAi(aiSetup.provider) : undefined;
// A shop may pick another provider (shop setting aiProvider); only providers with a key are available.
const aiByProvider: Record<string, EngineAi> = {};
if (aiSetup.enabled) for (const [name, p] of Object.entries(aiSetup.byProvider)) if (p) aiByProvider[name] = engineAi(p);
const prune = () => pruneAiAttempts(db).catch(() => 0);
void prune();
setInterval(() => void prune(), 6 * 3600_000).unref();
const synonyms = cachedSynonymIndex(db, 60_000);
const recordSuggestions = async (list: { term: string; canonicalAr: string; canonicalEn: string }[]) => {
  for (const s of list) await recordSuggestion(db, s);
};

const boss = new PgBoss({ connectionString: config.DATABASE_URL });
boss.on("error", (err) => console.error("pg-boss error", err));

await boss.start(); // creates/updates the pgboss schema in the same database
await boss.createQueue(QUEUES.inboundMessage);

await boss.work<InboundMessageJob>(QUEUES.inboundMessage, async (jobs) => {
  for (const job of jobs) {
    // Ids only in logs: job.data holds customer message text and phone numbers (PDPL).
    const outcome = await processInboundJob(job.data, { store, oneepc: oneepc.forShop({ testShop: false }), oneepcFor: (shop) => oneepc.forShop(shop), sender, dryRun, stock, allowSyntheticStockEnv: config.ALLOW_SYNTHETIC_STOCK, ...(ai ? { ai, aiByProvider } : {}), synonyms, recordSuggestions });
    console.log(JSON.stringify({ event: "job_done", jobId: job.id, outcome }));
  }
});
console.log(JSON.stringify({ event: "worker_started", dryRun, oneepcSources: oneepc.sources, oneepcRealKey: oneepc.real !== null, oneepcMock: oneepc.mock !== null, ai: aiSetup.enabled ? "on" : aiSetup.reason, aiProvider: config.AI_PROVIDER, aiChains: aiSetup.chains.filter((c) => c.keyConfigured).map((c) => `${c.provider}:${c.model}${c.fallbackModel ? `>${c.fallbackProvider ?? c.provider}:${c.fallbackModel}` : ""}`) }));

const shutdown = async () => {
  await boss.stop({ graceful: true });
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
