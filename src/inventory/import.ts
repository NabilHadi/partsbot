/** File -> parsed rows -> transactional replace. Shared by the CLI and tests. */
import path from "node:path";
import { parseStockRows, type ParseResult } from "./parse.js";
import { readRows, sourceKindFor } from "./read-sheet.js";
import { replaceShopInventory, type ConnectableDb, type ImportOutcome } from "./repository.js";

export interface ImportStockOptions {
  shopId: string;
  file: string;
  synthetic: { seed: number } | null;
  /** Parse and summarise only, write nothing. */
  dryRun?: boolean;
}

export interface ImportStockResult {
  parsed: ParseResult;
  outcome: ImportOutcome | null;
}

export async function importStockFile(db: ConnectableDb | null, opts: ImportStockOptions): Promise<ImportStockResult> {
  const source = sourceKindFor(opts.file);
  const parsed = await parseStockRows(readRows(opts.file), opts.synthetic ? { synthetic: opts.synthetic } : {});
  if (opts.dryRun || !db) return { parsed, outcome: null };
  const outcome = await replaceShopInventory(
    db,
    { shopId: opts.shopId, source, sourceName: path.basename(opts.file), synthetic: opts.synthetic },
    parsed,
  );
  return { parsed, outcome };
}

/** Summary lines (counts only: no names, no part numbers, nothing from rejected rows). */
export function summarize(r: ImportStockResult): string[] {
  const p = r.parsed;
  const items = p.items;
  const lines = [
    `header row: ${p.headerRow}  columns: ${Object.entries(p.columns).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    `rows read: ${p.rowsTotal}  imported: ${r.outcome?.rowsImported ?? `${items.length} (dry run)`}  rejected: ${p.rowsRejected}`,
  ];
  for (const [reason, n] of Object.entries(p.rejected).sort()) lines.push(`  rejected ${reason}: ${n}`);
  const withBase = items.filter((i) => i.oemBase).length;
  const withSuffix = items.filter((i) => i.variantSuffix).length;
  lines.push(`oem-style numbers: ${withBase}  with variant suffix: ${withSuffix}  shop codes (no base): ${items.length - withBase}`);
  lines.push(`inactive: ${items.filter((i) => !i.active).length}  with alt numbers in name: ${items.filter((i) => i.altNumbers.length).length}`);
  const qtys = items.map((i) => i.qty).filter((q): q is number => q !== null);
  const prices = items.map((i) => i.priceSar).filter((q): q is number => q !== null);
  if (qtys.length) lines.push(`qty: ${qtys.length} rows, zero ${qtys.filter((q) => q === 0).length} (${((100 * qtys.filter((q) => q === 0).length) / qtys.length).toFixed(1)}%), max ${Math.max(...qtys)}`);
  else lines.push("qty: none in file");
  if (prices.length) lines.push(`price_sar: ${prices.length} rows, min ${Math.min(...prices)}, max ${Math.max(...prices)}`);
  else lines.push("price_sar: none in file");
  if (items.some((i) => i.isSynthetic)) lines.push("SYNTHETIC: qty/price were generated (is_synthetic=true); hidden from real customers");
  if (r.outcome) lines.push(`import id: ${r.outcome.importId}  replaced ${r.outcome.deletedPrevious} previous rows  at ${r.outcome.importedAt.toISOString()}`);
  return lines;
}
