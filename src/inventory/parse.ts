/**
 * Turn sheet rows into stock items + reject counts. Pure (no DB, no logging).
 * PII rows (phone numbers as item numbers / in names) are dropped here and only COUNTED: their content never
 * leaves this function, never reaches the DB, and is never printed.
 */
import { HEADER_SCAN_ROWS, matchHeader, type ColumnMap } from "./header.js";
import {
  describeSuffix,
  extractAltNumbers,
  isPhoneLikeItemNumber,
  nameContainsPhone,
  normalizePartNumber,
  placeholderReason,
  splitOem,
  type RejectReason,
} from "./normalize.js";
import type { SheetRow } from "./read-sheet.js";
import { syntheticStock } from "./synthetic.js";

export interface StockItem {
  partNumberRaw: string;
  partNumberNormalized: string;
  oemBase: string | null;
  variantSuffix: string | null;
  nameAr: string | null;
  brand: string | null;
  unit: string | null;
  active: boolean;
  categoryCode: string | null;
  groupCode: string | null;
  altNumbers: string[];
  qty: number | null;
  priceSar: number | null;
  vatIncluded: boolean;
  isSynthetic: boolean;
  sourceRow: number;
}

export interface ParseOptions {
  /** Fill qty/price with seeded random values (see synthetic.ts). */
  synthetic?: { seed: number };
}

export interface ParseResult {
  headerRow: number;
  columns: ColumnMap;
  rowsTotal: number;
  items: StockItem[];
  rejected: Partial<Record<RejectReason, number>>;
  rowsRejected: number;
}

export class HeaderNotFoundError extends Error {
  constructor() {
    super(`header row not found in the first ${HEADER_SCAN_ROWS} rows (need a part-number column such as "رقم الصنف" and a name column such as "اسم الصنف")`);
  }
}

/** "1,250.50" / "١٢٥٠" / "" -> number | null. Never guesses: anything unparsable is null. */
export function parseNumberCell(s: string | undefined): number | null {
  if (!s) return null;
  const t = s
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066B/g, ".")
    .replace(/[,\u066C\s]/g, "")
    .replace(/(ريال|ر\.س|SAR)$/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

function cell(cells: string[], i: number | undefined): string {
  return i === undefined ? "" : (cells[i] ?? "").trim();
}

export async function parseStockRows(rows: AsyncIterable<SheetRow> | Iterable<SheetRow>, opts: ParseOptions = {}): Promise<ParseResult> {
  let columns: ColumnMap | null = null;
  let headerRow = 0;
  let scanned = 0;
  let rowsTotal = 0;
  const items: StockItem[] = [];
  const rejected: Partial<Record<RejectReason, number>> = {};
  const seen = new Set<string>();
  const reject = (r: RejectReason) => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };

  for await (const row of rows) {
    if (!columns) {
      columns = matchHeader(row.cells);
      if (columns) headerRow = row.rowNumber;
      else if (++scanned >= HEADER_SCAN_ROWS) throw new HeaderNotFoundError();
      continue;
    }
    const raw = cell(row.cells, columns.partNumber);
    const name = cell(row.cells, columns.name);
    if (!raw && !name) continue; // blank layout row, not counted
    rowsTotal++;

    const ph = placeholderReason(raw);
    if (ph) {
      reject(ph);
      continue;
    }
    // PII checks before anything else is derived from the row.
    if (isPhoneLikeItemNumber(raw)) {
      reject("pii_phone_item_number");
      continue;
    }
    if (nameContainsPhone(name)) {
      reject("pii_phone_in_name");
      continue;
    }

    // Kept as the shop wrote it: "04111-25091." and "04111-25091" can be two items in the shop's system.
    const partNumberRaw = raw.trim();
    if (seen.has(partNumberRaw)) {
      reject("duplicate_row");
      continue;
    }
    seen.add(partNumberRaw);

    const partNumberNormalized = normalizePartNumber(raw);
    const { oemBase, suffix } = splitOem(raw);
    const sfx = describeSuffix(suffix);
    const status = cell(row.cells, columns.status);
    let qty = parseNumberCell(cell(row.cells, columns.qty));
    let priceSar = parseNumberCell(cell(row.cells, columns.price));
    if (opts.synthetic) ({ qty, priceSar } = syntheticStock(opts.synthetic.seed, partNumberRaw));

    items.push({
      partNumberRaw,
      partNumberNormalized,
      oemBase,
      variantSuffix: suffix,
      nameAr: name || null,
      brand: cell(row.cells, columns.brand) || sfx.brand,
      unit: cell(row.cells, columns.unit) || null,
      active: status === "" ? true : !/^(0|لا|false|no|غير نشط)$/i.test(status),
      categoryCode: cell(row.cells, columns.category) || null,
      groupCode: cell(row.cells, columns.group) || null,
      altNumbers: extractAltNumbers(name, partNumberNormalized),
      qty: qty === null ? null : Math.max(0, Math.trunc(qty)),
      priceSar: priceSar === null ? null : Math.round(priceSar * 100) / 100,
      vatIncluded: true, // Saudi retail prices are quoted VAT-inclusive; synthetic prices are generated that way
      isSynthetic: !!opts.synthetic,
      sourceRow: row.rowNumber,
    });
  }
  if (!columns) throw new HeaderNotFoundError();
  const rowsRejected = Object.values(rejected).reduce((a, b) => a + (b ?? 0), 0);
  return { headerRow, columns, rowsTotal, items, rejected, rowsRejected };
}
