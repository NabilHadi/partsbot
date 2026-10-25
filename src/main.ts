import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const app = buildServer({ db });

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
