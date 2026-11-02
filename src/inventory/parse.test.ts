import { describe, expect, it } from "vitest";
import { HeaderNotFoundError, parseNumberCell, parseStockRows } from "./parse.js";
import { matchHeader } from "./header.js";
import type { SheetRow } from "./read-sheet.js";
import { SYNTHETIC, syntheticStock } from "./synthetic.js";

/** Build sheet rows like the Medrar export: banner rows, then header, then data (1-based cells). */
function sheet(rows: string[][], startRow = 1): SheetRow[] {
  return rows.map((r, i) => ({ rowNumber: startRow + i, cells: [""].concat(r) }));
}

const BANNER = [["تقرير بيانات الاصناف"], [], ["الفرع: 51"], []];
const HEADER = ["الحالة", "الوحدة", "التصنيف الاول", "المجموعة", "اسم الصنف", "رقم الصنف"];
const row = (num: string, name: string, status = "1") => [status, "حبة", "3", "3", name, num];

describe("header detection", () => {
  it("finds the Arabic header after a banner, whatever its row", async () => {
    const r = await parseStockRows(sheet([...BANNER, HEADER, row("04465-06090", "فحمات امامي كامري")]));
    expect(r.headerRow).toBe(5);
    expect(r.columns).toMatchObject({ status: 1, unit: 2, category: 3, group: 4, name: 5, partNumber: 6 });
    expect(r.items).toHaveLength(1);
  });

  it("accepts English headers and qty/price columns", () => {
    expect(matchHeader(["", "Part Number", "Name", "Qty", "Price"])).toEqual({ partNumber: 1, name: 2, qty: 3, price: 4 });
    expect(matchHeader(["", "رقم الصنف", "اسم الصنف", "الرصيد", "سعر البيع", "الماركة"])).toMatchObject({ qty: 3, price: 4, brand: 5 });
  });

  it("needs both a number and a name column", () => {
    expect(matchHeader(["", "رقم الصنف", "الكمية"])).toBeNull();
  });

  it("fails clearly when no header is found", async () => {
    const rows = sheet(Array.from({ length: 60 }, () => ["x", "y"]));
    await expect(parseStockRows(rows)).rejects.toBeInstanceOf(HeaderNotFoundError);
  });
});

describe("row classification", () => {
  it("rejects placeholders and PII rows, counting them without keeping any content", async () => {
    const r = await parseStockRows(
      sheet([
        HEADER,
        row("04465-06090-J", "قماش امامي كامري ياباني"),
        row(".", "استكات"),
        row("00000-00000", "متفرقات"),
        row("1.172-13E+11", "حساس"),
        row("0551234567", "PERSON-NAME-A"),
        row("X1001", "PERSON-NAME-B 0559876543"),
        row("04465-06090", "فحمات امامي", "0"),
      ]),
    );
    expect(r.rowsTotal).toBe(7);
    expect(r.items.map((i) => i.partNumberRaw)).toEqual(["04465-06090-J", "04465-06090"]);
    expect(r.rejected).toEqual({
      placeholder_part_number: 2,
      spreadsheet_number_mangled: 1,
      pii_phone_item_number: 1,
      pii_phone_in_name: 1,
    });
    expect(r.rowsRejected).toBe(5);
    const dump = JSON.stringify(r);
    for (const pii of ["0551234567", "0559876543", "PERSON-NAME-A", "PERSON-NAME-B"]) expect(dump).not.toContain(pii);
  });

  it("derives normalized number, base, suffix, brand, status, alt numbers", async () => {
    const r = await parseStockRows(
      sheet([HEADER, row("17801-0H030-DENSO", "فلتر هواء كامري 17801-28030"), row("04465-06090", "فحمات", "0")]),
    );
    expect(r.items[0]).toMatchObject({
      partNumberNormalized: "178010H030DENSO",
      oemBase: "178010H030",
      variantSuffix: "DENSO",
      brand: "DENSO",
      active: true,
      altNumbers: ["1780128030"],
      qty: null,
      priceSar: null,
      isSynthetic: false,
      sourceRow: 2,
    });
    expect(r.items[1]?.active).toBe(false);
  });

  it("keeps trailing-dot twins as separate rows, drops exact repeats", async () => {
    const r = await parseStockRows(sheet([HEADER, row("04111-25091", "a"), row("04111-25091.", "b"), row("04111-25091", "c")]));
    expect(r.items.map((i) => i.partNumberRaw)).toEqual(["04111-25091", "04111-25091."]);
    expect(r.rejected.duplicate_row).toBe(1);
  });

  it("reads qty/price columns when the file has them (never guesses)", async () => {
    const r = await parseStockRows(
      sheet([["رقم الصنف", "اسم الصنف", "الكمية", "السعر"], ["04465-06090", "فحمات", "٣", "1,250.50"], ["90915-YZZE1", "فلتر", "", "abc"]]),
    );
    expect(r.items[0]).toMatchObject({ qty: 3, priceSar: 1250.5 });
    expect(r.items[1]).toMatchObject({ qty: null, priceSar: null });
  });

  it("parseNumberCell", () => {
    expect(parseNumberCell("١٢٥٠")).toBe(1250);
    expect(parseNumberCell("15 ريال")).toBe(15);
    expect(parseNumberCell("n/a")).toBeNull();
    expect(parseNumberCell("")).toBeNull();
  });
});

describe("synthetic stock", () => {
  it("is reproducible per seed and part number, and marked synthetic", async () => {
    const rows = sheet([HEADER, row("04465-06090", "a"), row("90915-YZZE1", "b")]);
    const a = await parseStockRows(rows, { synthetic: { seed: 51 } });
    const b = await parseStockRows(rows, { synthetic: { seed: 51 } });
    expect(a.items.map((i) => [i.qty, i.priceSar])).toEqual(b.items.map((i) => [i.qty, i.priceSar]));
    expect(a.items.every((i) => i.isSynthetic && i.vatIncluded)).toBe(true);
    expect(syntheticStock(51, "04465-06090")).toEqual(syntheticStock(51, "04465-06090"));
    expect(syntheticStock(52, "04465-06090")).not.toEqual(syntheticStock(51, "04465-06090"));
  });

  it("does not depend on row order", () => {
    const pns = ["04465-06090", "90915-YZZE1", "17801-0H030"];
    const fwd = pns.map((p) => syntheticStock(7, p));
    const rev = [...pns].reverse().map((p) => syntheticStock(7, p)).reverse();
    expect(fwd).toEqual(rev);
  });

  it("qty 0-20 with ~25% zero, price 15-1500 SAR", () => {
    const n = 20_000;
    let zero = 0;
    for (let i = 0; i < n; i++) {
      const s = syntheticStock(1, `P${i}`);
      expect(s.qty).toBeGreaterThanOrEqual(0);
      expect(s.qty).toBeLessThanOrEqual(SYNTHETIC.maxQty);
      expect(s.priceSar).toBeGreaterThanOrEqual(SYNTHETIC.minPriceSar);
      expect(s.priceSar).toBeLessThanOrEqual(SYNTHETIC.maxPriceSar);
      if (s.qty === 0) zero++;
    }
    expect(zero / n).toBeGreaterThan(0.23);
    expect(zero / n).toBeLessThan(0.27);
  });
});
