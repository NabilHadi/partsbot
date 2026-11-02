/**
 * Find the header row by its column names (Arabic or English), not by position: the Medrar export has a
 * 13-row report banner and merged layout columns, other shops' exports will differ.
 */

export type ColumnKey =
  | "partNumber"
  | "name"
  | "qty"
  | "price"
  | "brand"
  | "status"
  | "unit"
  | "category"
  | "group";

/** Accepted header texts per field, compared after `normalizeHeader`. First entries come from the Medrar sample. */
export const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  partNumber: ["رقم الصنف", "رقم القطعة", "رقم القطعه", "part number", "part_number", "part no", "sku", "item number"],
  name: ["اسم الصنف", "اسم القطعة", "اسم القطعه", "الاسم", "الوصف", "name", "item name", "description", "name_ar"],
  qty: ["الكمية", "الكميه", "الرصيد", "الكمية المتاحة", "qty", "quantity", "stock", "on hand"],
  price: ["سعر البيع", "السعر", "سعر", "price", "price_sar", "sell price"],
  brand: ["الماركة", "الماركه", "الشركة المصنعة", "brand", "make"],
  status: ["الحالة", "الحاله", "status", "active"],
  unit: ["الوحدة", "الوحده", "unit"],
  category: ["التصنيف الاول", "التصنيف الأول", "category"],
  group: ["المجموعة", "المجموعه", "group"],
};

export function normalizeHeader(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const ALIAS_INDEX: Map<string, ColumnKey> = new Map(
  (Object.entries(HEADER_ALIASES) as [ColumnKey, string[]][]).flatMap(([k, names]) => names.map((n) => [normalizeHeader(n), k] as const)),
);

export type ColumnMap = Partial<Record<ColumnKey, number>>;

/** Column map for a candidate header row, or null if it lacks a part-number column AND a name column. */
export function matchHeader(cells: string[]): ColumnMap | null {
  const map: ColumnMap = {};
  cells.forEach((c, i) => {
    if (!c) return;
    const key = ALIAS_INDEX.get(normalizeHeader(c));
    if (key && map[key] === undefined) map[key] = i;
  });
  return map.partNumber !== undefined && map.name !== undefined ? map : null;
}

/** How far down to look for the header (banners are short; data rows never match). */
export const HEADER_SCAN_ROWS = 50;
