/**
 * Stock lookup for the bot, after OneEPC has given a confirmed part number.
 *
 *   1. exact: shop rows whose normalized number equals the OneEPC number's normalized form;
 *   2. variants: other rows with the same 10-char OEM base (origin / brand / quality versions, e.g. "-J", "-CH",
 *      "-DENSO"), in stock first.
 *
 * SAFETY: synthetic rows (generated qty/price, inventory_items.is_synthetic) must never reach a real customer.
 * They are filtered out in the SQL AND again in `buildPartStock` unless `allowSynthetic` is true, which needs
 * a shop flagged `testShop` plus an explicit opt-in (shop config `allowSyntheticStock` or env
 * ALLOW_SYNTHETIC_STOCK=true). Otherwise synthetic rows count as "no stock row".
 */
import type { Db } from "../db/pool.js";
import { describeSuffix, normalizePartNumber, splitOem, type SuffixInfo } from "./normalize.js";

/** One row as the lookup sees it (no names: replies use the OneEPC name, never the shop's free text). */
export interface StockRow {
  partNumberRaw: string;
  partNumberNormalized: string;
  oemBase: string | null;
  variantSuffix: string | null;
  qty: number | null;
  priceSar: number | null;
  vatIncluded: boolean;
  isSynthetic: boolean;
  active: boolean;
  importedAt: Date;
}

export interface StockEntry {
  suffix: string | null;
  suffixInfo: SuffixInfo;
  qty: number | null;
  priceSar: number | null;
  vatIncluded: boolean;
}

export interface PartStock {
  /** Rows with the same number (several rows can normalize the same; quantities are summed). */
  exact: StockEntry | null;
  /** Same OEM base, different suffix; sorted, at most MAX_VARIANTS. */
  variants: StockEntry[];
  /** Freshness: when the newest contributing import finished. */
  importedAt: Date;
  /** True if any contributing row is synthetic (only possible when allowed). */
  synthetic: boolean;
}

export const MAX_VARIANTS = 4;

/** Rows for these keys, synthetic rows excluded unless `allowSynthetic`. */
export interface StockSource {
  find(shopId: string, keys: { normalized: string[]; bases: string[] }, allowSynthetic: boolean): Promise<StockRow[]>;
}

/** What the engine calls: OneEPC part numbers -> stock per number (missing key = no stock row). */
export type StockLookup = (partNumbers: string[]) => Promise<Map<string, PartStock>>;

export interface SyntheticPolicy {
  testShop: boolean;
  allowSyntheticStock: boolean;
  envAllowSynthetic: boolean;
}

/** Synthetic stock is shown only to a TEST shop that opted in (config or env). A real shop never sees it. */
export function syntheticAllowed(p: SyntheticPolicy): boolean {
  return p.testShop === true && (p.allowSyntheticStock === true || p.envAllowSynthetic === true);
}

export function envAllowsSynthetic(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_SYNTHETIC_STOCK === "true";
}

const KIND_ORDER: Record<SuffixInfo["kind"], number> = { none: 0, origin: 1, brand: 2, unknown: 3 };

function toEntry(rows: StockRow[]): StockEntry {
  const sorted = [...rows].sort(byAvailability);
  const first = sorted[0] as StockRow;
  const qtys = rows.map((r) => r.qty).filter((q): q is number => q !== null);
  const priced = sorted.find((r) => r.priceSar !== null && (r.qty ?? 0) > 0) ?? sorted.find((r) => r.priceSar !== null);
  return {
    suffix: first.variantSuffix,
    suffixInfo: describeSuffix(first.variantSuffix),
    qty: qtys.length > 0 ? qtys.reduce((a, b) => a + b, 0) : null,
    priceSar: priced?.priceSar ?? null,
    vatIncluded: priced?.vatIncluded ?? first.vatIncluded,
  };
}

function byAvailability(a: StockRow, b: StockRow): number {
  const ia = (a.qty ?? 0) > 0 ? 0 : 1;
  const ib = (b.qty ?? 0) > 0 ? 0 : 1;
  return ia - ib || a.partNumberRaw.localeCompare(b.partNumberRaw);
}

/** Pure: stock for one OneEPC part number from candidate rows. Applies the synthetic guard again. */
export function buildPartStock(oneEpcPartNumber: string, rows: StockRow[], allowSynthetic: boolean): PartStock | null {
  const norm = normalizePartNumber(oneEpcPartNumber);
  const base = splitOem(oneEpcPartNumber).oemBase;
  const usable = rows.filter((r) => r.active && (allowSynthetic || !r.isSynthetic));
  const exactRows = usable.filter((r) => r.partNumberNormalized === norm);
  const variantRows = base ? usable.filter((r) => r.oemBase === base && r.partNumberNormalized !== norm) : [];
  if (exactRows.length === 0 && variantRows.length === 0) return null;

  // Group variants by suffix (normalized), so "-J" and "J" rows of the same number merge.
  const groups = new Map<string, StockRow[]>();
  for (const r of variantRows) {
    const k = r.partNumberNormalized;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const variants = [...groups.values()]
    .map(toEntry)
    .sort((a, b) => {
      const ia = (a.qty ?? 0) > 0 ? 0 : 1;
      const ib = (b.qty ?? 0) > 0 ? 0 : 1;
      return ia - ib || KIND_ORDER[a.suffixInfo.kind] - KIND_ORDER[b.suffixInfo.kind] || (a.suffix ?? "").localeCompare(b.suffix ?? "");
    })
    .slice(0, MAX_VARIANTS);

  const contributing = [...exactRows, ...variantRows];
  return {
    exact: exactRows.length > 0 ? toEntry(exactRows) : null,
    variants,
    importedAt: new Date(Math.max(...contributing.map((r) => r.importedAt.getTime()))),
    synthetic: contributing.some((r) => r.isSynthetic),
  };
}

export function createStockLookup(source: StockSource, shopId: string, allowSynthetic: boolean): StockLookup {
  return async (partNumbers) => {
    const normalized = [...new Set(partNumbers.map(normalizePartNumber).filter(Boolean))];
    const bases = [...new Set(partNumbers.map((p) => splitOem(p).oemBase).filter((b): b is string => !!b))];
    const out = new Map<string, PartStock>();
    if (normalized.length === 0) return out;
    const rows = await source.find(shopId, { normalized, bases }, allowSynthetic);
    for (const pn of partNumbers) {
      const ps = buildPartStock(pn, rows, allowSynthetic);
      if (ps) out.set(pn, ps);
    }
    return out;
  };
}

// ------------------------------------------------------------------ sources

export class InMemoryStockSource implements StockSource {
  constructor(readonly rows: (StockRow & { shopId: string })[] = []) {}
  async find(shopId: string, keys: { normalized: string[]; bases: string[] }, allowSynthetic: boolean) {
    return this.rows.filter(
      (r) =>
        r.shopId === shopId &&
        r.active &&
        (allowSynthetic || !r.isSynthetic) &&
        (keys.normalized.includes(r.partNumberNormalized) || (r.oemBase !== null && keys.bases.includes(r.oemBase))),
    );
  }
}

export class PgStockSource implements StockSource {
  constructor(private readonly db: Pick<Db, "query">) {}
  async find(shopId: string, keys: { normalized: string[]; bases: string[] }, allowSynthetic: boolean): Promise<StockRow[]> {
    const r = await this.db.query<{
      part_number_raw: string;
      part_number_normalized: string;
      oem_base: string | null;
      variant_suffix: string | null;
      qty: number | null;
      price_sar: string | null;
      vat_included: boolean;
      is_synthetic: boolean;
      active: boolean;
      imported_at: Date;
    }>(
      `SELECT i.part_number_raw, i.part_number_normalized, i.oem_base, i.variant_suffix, i.qty, i.price_sar,
              i.vat_included, i.is_synthetic, i.active, COALESCE(m.imported_at, m.started_at) AS imported_at
         FROM inventory_items i
         JOIN inventory_imports m ON m.id = i.import_id
        WHERE i.shop_id = $1
          AND i.active
          AND (i.part_number_normalized = ANY($2::text[]) OR i.oem_base = ANY($3::text[]))
          AND (NOT i.is_synthetic OR $4::boolean)
        ORDER BY (i.part_number_normalized = ANY($2::text[])) DESC, (COALESCE(i.qty, 0) > 0) DESC, i.part_number_raw
        LIMIT 200`,
      [shopId, keys.normalized, keys.bases, allowSynthetic],
    );
    return r.rows.map((x) => ({
      partNumberRaw: x.part_number_raw,
      partNumberNormalized: x.part_number_normalized,
      oemBase: x.oem_base,
      variantSuffix: x.variant_suffix,
      qty: x.qty,
      priceSar: x.price_sar === null ? null : Number(x.price_sar),
      vatIncluded: x.vat_included,
      isSynthetic: x.is_synthetic,
      active: x.active,
      importedAt: x.imported_at,
    }));
  }
}
