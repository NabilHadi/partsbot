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

const app = buildServer({ db, zernio });

const shutdown = async () => {
  await app.close();
  await boss?.stop({ graceful: true });
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
