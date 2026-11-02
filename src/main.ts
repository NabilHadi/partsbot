import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import PgBoss from "pg-boss";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createPgBossInboundQueue } from "./queue/inbound.js";
import { QUEUES } from "./queues.js";
import { buildServer, type ServerDeps } from "./server.js";
import { createPgDedupeStore } from "./zernio/dedupe.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

// The webhook route needs the shared secret; without it the route is simply not mounted (Zernio would get 404s).
let boss: PgBoss | undefined;
let zernio: ServerDeps["zernio"];
if (config.ZERNIO_WEBHOOK_SECRET) {
  boss = new PgBoss({ connectionString: config.DATABASE_URL });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await boss.createQueue(QUEUES.inboundMessage);
  zernio = {
    secret: config.ZERNIO_WEBHOOK_SECRET,
    accountId: config.ZERNIO_ACCOUNT_ID,
    dedupe: createPgDedupeStore(db),
    queue: createPgBossInboundQueue(boss),
  };
} else {
  console.warn("ZERNIO_WEBHOOK_SECRET is not set: POST /webhooks/zernio is NOT mounted");
}

function gitCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

if (!config.ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set: /admin answers 503");
const app = buildServer({
  db,
  zernio,
  admin: {
    db,
    password: config.ADMIN_PASSWORD,
    status: {
      dryRun: config.DRY_RUN,
      oneepcBaseUrl: config.ONEEPC_BASE_URL,
      zernioWebhookConfigured: !!config.ZERNIO_WEBHOOK_SECRET,
      zernioApiKeyConfigured: !!config.ZERNIO_API_KEY,
      version: pkg.version,
      commit: gitCommit(),
      queueName: QUEUES.inboundMessage,
    },
  },
});

const shutdown = async () => {
  await app.close();
  await boss?.stop({ graceful: true });
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
