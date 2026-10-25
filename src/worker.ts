import PgBoss from "pg-boss";
import { loadConfig } from "./config.js";
import { QUEUES } from "./queues.js";

const config = loadConfig();
const boss = new PgBoss({ connectionString: config.DATABASE_URL });
boss.on("error", (err) => console.error("pg-boss error", err));

await boss.start(); // creates/updates the pgboss schema in the same database
await boss.createQueue(QUEUES.inboundMessage);

// Placeholder handler: the real pipeline (debounce, gate checks, extract, decode, search, reply) goes here.
await boss.work(QUEUES.inboundMessage, async (jobs) => {
  for (const job of jobs) {
    // Ids only: job.data holds customer message text and phone numbers (PDPL), never log it.
    console.log(`job ${job.id} on ${QUEUES.inboundMessage}`);
  }
});
console.log("worker started");

const shutdown = async () => {
  await boss.stop({ graceful: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
