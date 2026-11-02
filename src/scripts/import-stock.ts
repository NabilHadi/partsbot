// Import a shop's stock export (xlsx / xlsm / csv) into inventory_items, replacing the shop's previous list.
// Usage:
//   npm run import-stock -- --shop <shop uuid> --file <path> [--synthetic-stock --seed 42] [--dry-run]
// xlsm files are read as DATA ONLY (macros are never run). Rows holding personal data are skipped and only counted.
// --synthetic-stock fills qty/price with seeded random values for testing; such rows are hidden from real customers.
import { parseArgs } from "node:util";
import { createPool } from "../db/pool.js";
import { importStockFile, summarize } from "../inventory/import.js";

const USAGE = "usage: npm run import-stock -- --shop <shop uuid> --file <path> [--synthetic-stock --seed N] [--dry-run]";

const { values } = parseArgs({
  options: {
    shop: { type: "string" },
    file: { type: "string" },
    "synthetic-stock": { type: "boolean", default: false },
    seed: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(`${msg}\n${USAGE}`);
  process.exit(2);
}

if (!values.file) fail("missing --file");
if (!values["dry-run"] && !values.shop) fail("missing --shop");
if (values.shop && !/^[0-9a-f-]{36}$/i.test(values.shop)) fail("--shop must be a shop uuid");
let synthetic: { seed: number } | null = null;
if (values["synthetic-stock"]) {
  const seed = values.seed === undefined ? 1 : Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) fail("--seed must be a non-negative integer");
  synthetic = { seed };
} else if (values.seed !== undefined) fail("--seed only applies with --synthetic-stock");

const dryRun = values["dry-run"] === true;
const db = dryRun ? null : createPool(process.env.DATABASE_URL ?? fail("DATABASE_URL is not set"));
try {
  if (db && values.shop) {
    const shop = await db.query<{ name: string }>("SELECT name FROM shops WHERE id = $1", [values.shop]);
    if (!shop.rows[0]) fail("shop not found");
    console.log(`shop: ${shop.rows[0].name}`);
  }
  const t0 = Date.now();
  const result = await importStockFile(db, { shopId: values.shop ?? "", file: values.file, synthetic, dryRun });
  for (const l of summarize(result)) console.log(l);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s${synthetic ? ` (seed ${synthetic.seed})` : ""}`);
} catch (err) {
  console.error(`import failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db?.end();
}
