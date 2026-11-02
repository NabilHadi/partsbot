/**
 * Write an import: ONE transaction that records the import, deletes the shop's previous items and inserts
 * the new ones. Readers see either the old list or the new one, never a mix. On failure everything rolls back
 * and a `failed` import row (counts + error class only) is written separately.
 */
import type { ParseResult, StockItem } from "./parse.js";
import type { SourceKind } from "./read-sheet.js";

/** The bits of pg.Pool / pg.PoolClient we use (so tests can pass a fake). */
export interface Queryable {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}
export interface ConnectableDb extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

export interface ImportMeta {
  shopId: string;
  source: SourceKind;
  sourceName: string;
  synthetic: { seed: number } | null;
}

export interface ImportOutcome {
  importId: string;
  importedAt: Date;
  rowsImported: number;
  deletedPrevious: number;
}

export const INSERT_BATCH = 5000;

const ITEM_COLUMNS = [
  ["part_number_raw", "text"],
  ["part_number_normalized", "text"],
  ["oem_base", "text"],
  ["variant_suffix", "text"],
  ["name_ar", "text"],
  ["brand", "text"],
  ["unit", "text"],
  ["active", "boolean"],
  ["category_code", "text"],
  ["group_code", "text"],
  ["alt_numbers", "text"], // sent as a JSON text per row, cast below (unnest cannot take text[][] of ragged arrays)
  ["qty", "integer"],
  ["price_sar", "numeric"],
  ["vat_included", "boolean"],
  ["is_synthetic", "boolean"],
  ["source_row", "integer"],
] as const;

function columnValues(batch: StockItem[]): unknown[][] {
  return [
    batch.map((i) => i.partNumberRaw),
    batch.map((i) => i.partNumberNormalized),
    batch.map((i) => i.oemBase),
    batch.map((i) => i.variantSuffix),
    batch.map((i) => i.nameAr),
    batch.map((i) => i.brand),
    batch.map((i) => i.unit),
    batch.map((i) => i.active),
    batch.map((i) => i.categoryCode),
    batch.map((i) => i.groupCode),
    batch.map((i) => JSON.stringify(i.altNumbers)),
    batch.map((i) => i.qty),
    batch.map((i) => i.priceSar),
    batch.map((i) => i.vatIncluded),
    batch.map((i) => i.isSynthetic),
    batch.map((i) => i.sourceRow),
  ];
}

const INSERT_SQL = `
  INSERT INTO inventory_items (shop_id, import_id, ${ITEM_COLUMNS.map(([c]) => c).join(", ")})
  SELECT $1, $2, ${ITEM_COLUMNS.map(([c]) =>
    c === "alt_numbers" ? `ARRAY(SELECT jsonb_array_elements_text(u.alt_numbers::jsonb))` : `u.${c}`,
  ).join(", ")}
    FROM unnest(${ITEM_COLUMNS.map(([, t], i) => `$${i + 3}::${t}[]`).join(", ")})
      AS u(${ITEM_COLUMNS.map(([c]) => c).join(", ")})`;

export async function replaceShopInventory(db: ConnectableDb, meta: ImportMeta, parsed: ParseResult): Promise<ImportOutcome> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One import per shop at a time (a second run waits instead of interleaving deletes).
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 727004))", [`inventory:${meta.shopId}`]);
    const imp = await client.query<{ id: string }>(
      `INSERT INTO inventory_imports (shop_id, source, source_name, status, is_synthetic, synthetic_seed, header_row,
                                      rows_total, rows_rejected, rejected_counts)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
      [
        meta.shopId,
        meta.source,
        meta.sourceName,
        meta.synthetic !== null,
        meta.synthetic?.seed ?? null,
        parsed.headerRow,
        parsed.rowsTotal,
        parsed.rowsRejected,
        JSON.stringify(parsed.rejected),
      ],
    );
    const importId = (imp.rows[0] as { id: string }).id;
    const del = await client.query("DELETE FROM inventory_items WHERE shop_id = $1", [meta.shopId]);
    let inserted = 0;
    for (let i = 0; i < parsed.items.length; i += INSERT_BATCH) {
      const batch = parsed.items.slice(i, i + INSERT_BATCH);
      const r = await client.query(INSERT_SQL, [meta.shopId, importId, ...columnValues(batch)]);
      inserted += r.rowCount ?? batch.length;
    }
    const done = await client.query<{ imported_at: Date }>(
      `UPDATE inventory_imports SET status = 'completed', rows_imported = $2, imported_at = now() WHERE id = $1 RETURNING imported_at`,
      [importId, inserted],
    );
    await client.query("COMMIT");
    return { importId, importedAt: (done.rows[0] as { imported_at: Date }).imported_at, rowsImported: inserted, deletedPrevious: del.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Record the failure outside the rolled-back transaction: counts and the error class only.
    await db
      .query(
        `INSERT INTO inventory_imports (shop_id, source, source_name, status, is_synthetic, synthetic_seed, header_row,
                                        rows_total, rows_rejected, rejected_counts, error)
         VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          meta.shopId,
          meta.source,
          meta.sourceName,
          meta.synthetic !== null,
          meta.synthetic?.seed ?? null,
          parsed.headerRow,
          parsed.rowsTotal,
          parsed.rowsRejected,
          JSON.stringify(parsed.rejected),
          `${(err as Error)?.name ?? "Error"}: ${String((err as Error)?.message ?? "").slice(0, 200)}`,
        ],
      )
      .catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
