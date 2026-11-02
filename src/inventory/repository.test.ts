import { describe, expect, it } from "vitest";
import pg from "pg";
import { parseStockRows } from "./parse.js";
import { replaceShopInventory, type ConnectableDb, INSERT_BATCH } from "./repository.js";
import type { SheetRow } from "./read-sheet.js";

const HEADER = ["رقم الصنف", "اسم الصنف"];
const sheet = (rows: string[][]): SheetRow[] => rows.map((r, i) => ({ rowNumber: i + 1, cells: [""].concat(r) }));

function fakeDb(failOn?: RegExp) {
  const log: string[] = [];
  const outside: string[] = [];
  let released = 0;
  const q = (bucket: string[]) => async (text: string, params?: unknown[]) => {
    const t = text.trim().split(/\s+/).slice(0, 3).join(" ");
    bucket.push(t);
    if (failOn?.test(text)) throw new Error("boom");
    if (/RETURNING id/.test(text)) return { rows: [{ id: "imp_1" }], rowCount: 1 };
    if (/RETURNING imported_at/.test(text)) return { rows: [{ imported_at: new Date(0) }], rowCount: 1 };
    if (/^DELETE/.test(text.trim())) return { rows: [], rowCount: 42 };
    if (/INSERT INTO inventory_items/.test(text)) return { rows: [], rowCount: (params?.[2] as unknown[]).length };
    return { rows: [], rowCount: 0 };
  };
  const db: ConnectableDb = {
    query: q(outside) as ConnectableDb["query"],
    connect: async () => ({ query: q(log) as ConnectableDb["query"], release: () => void released++ }),
  };
  return { db, log, outside, released: () => released };
}

const meta = { shopId: "shop_1", source: "xlsx" as const, sourceName: "x.xlsm", synthetic: { seed: 1 } };

describe("replaceShopInventory (fake client)", () => {
  it("one transaction: lock, record import, delete old items, insert, complete, commit", async () => {
    const parsed = await parseStockRows(sheet([HEADER, ["04465-06090", "a"], ["0551234567", "pii"]]), { synthetic: { seed: 1 } });
    const { db, log, outside, released } = fakeDb();
    const out = await replaceShopInventory(db, meta, parsed);
    expect(log).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 727004))",
      "INSERT INTO inventory_imports",
      "DELETE FROM inventory_items",
      "INSERT INTO inventory_items",
      "UPDATE inventory_imports SET",
      "COMMIT",
    ]);
    expect(outside).toEqual([]);
    expect(out).toMatchObject({ importId: "imp_1", rowsImported: 1, deletedPrevious: 42 });
    expect(released()).toBe(1);
  });

  it("batches large imports", async () => {
    const rows = [HEADER, ...Array.from({ length: INSERT_BATCH + 3 }, (_, i) => [`P${i}`, "n"])];
    const { db, log } = fakeDb();
    const out = await replaceShopInventory(db, meta, await parseStockRows(sheet(rows)));
    expect(log.filter((l) => l === "INSERT INTO inventory_items")).toHaveLength(2);
    expect(out.rowsImported).toBe(INSERT_BATCH + 3);
  });

  it("on failure rolls back (old items kept) and records a failed import with counts only", async () => {
    const parsed = await parseStockRows(sheet([HEADER, ["04465-06090", "a"]]));
    const { db, log, outside, released } = fakeDb(/INSERT INTO inventory_items/);
    await expect(replaceShopInventory(db, meta, parsed)).rejects.toThrow("boom");
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(log).not.toContain("COMMIT");
    expect(outside).toEqual(["INSERT INTO inventory_imports"]);
    expect(released()).toBe(1);
  });
});

// Real Postgres: set TEST_DATABASE_URL to a throwaway database with migrations applied.
const TEST_DB = process.env.TEST_DATABASE_URL;
describe.skipIf(!TEST_DB)("replaceShopInventory (real Postgres)", () => {
  it("replaces the shop's items atomically and keeps them on failure", async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB });
    try {
      const shop = await pool.query<{ id: string }>(
        `INSERT INTO shops (name, config) VALUES ('inventory test (fake)', '{}'::jsonb) RETURNING id`,
      );
      const shopId = shop.rows[0]!.id;
      const m = { ...meta, shopId };
      await replaceShopInventory(pool, m, await parseStockRows(sheet([HEADER, ["04465-06090", "a"], ["90915-YZZE1", "b"]])));
      await replaceShopInventory(pool, m, await parseStockRows(sheet([HEADER, ["17801-0H030", "c"]])));
      const items = await pool.query(`SELECT part_number_raw FROM inventory_items WHERE shop_id = $1`, [shopId]);
      expect(items.rows.map((r) => r.part_number_raw)).toEqual(["17801-0H030"]);
      const bad = await parseStockRows(sheet([HEADER, ["04465-06090", "a"]]));
      bad.items[0]!.qty = -1; // violates the CHECK -> whole transaction rolls back
      await expect(replaceShopInventory(pool, m, bad)).rejects.toThrow();
      const after = await pool.query(`SELECT part_number_raw FROM inventory_items WHERE shop_id = $1`, [shopId]);
      expect(after.rows.map((r) => r.part_number_raw)).toEqual(["17801-0H030"]);
      const imps = await pool.query(`SELECT status FROM inventory_imports WHERE shop_id = $1 ORDER BY started_at`, [shopId]);
      expect(imps.rows.map((r) => r.status).sort()).toEqual(["completed", "completed", "failed"]);
      await pool.query(`DELETE FROM shops WHERE id = $1`, [shopId]);
    } finally {
      await pool.end();
    }
  });
});
