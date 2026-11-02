import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importStockFile, summarize } from "./import.js";
import { parseCsv, readRows, sourceKindFor } from "./read-sheet.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "inv-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseCsv", () => {
  it("handles BOM, quotes, embedded commas/newlines and CRLF", () => {
    expect(parseCsv('\uFEFFa,"b,c"\r\n"x ""y""","multi\nline"\n')).toEqual([
      ["a", "b,c"],
      ['x "y"', "multi\nline"],
    ]);
  });
});

describe("sourceKindFor", () => {
  it("xlsx, xlsm, csv; rejects others", () => {
    expect(sourceKindFor("a.XLSM")).toBe("xlsx");
    expect(sourceKindFor("a.xlsx")).toBe("xlsx");
    expect(sourceKindFor("a.csv")).toBe("csv");
    expect(() => sourceKindFor("a.xls")).toThrow();
  });
});

describe("reading files end to end (dry run, no DB)", () => {
  it("xlsx with banner rows and rich text cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    ws.addRow(["تقرير بيانات الاصناف"]);
    ws.addRow([]);
    ws.addRow(["الحالة", "اسم الصنف", "رقم الصنف"]);
    ws.addRow([1, { richText: [{ text: "فلتر " }, { text: "زيت" }] }, "90915-YZZE1"]);
    ws.addRow([1, "PERSON", "0551234567"]);
    const file = path.join(dir, "t.xlsm");
    await wb.xlsx.writeFile(file);
    const rows = [];
    for await (const r of readRows(file)) rows.push(r);
    expect(rows.find((r) => r.rowNumber === 4)?.cells.slice(1, 4)).toEqual(["1", "فلتر زيت", "90915-YZZE1"]);

    const res = await importStockFile(null, { shopId: "s", file, synthetic: { seed: 3 }, dryRun: true });
    expect(res.parsed.items).toHaveLength(1);
    expect(res.parsed.rejected).toEqual({ pii_phone_item_number: 1 });
    const out = summarize(res).join("\n");
    expect(out).not.toContain("0551234567");
    expect(out).not.toContain("PERSON");
  });

  it("csv", async () => {
    const file = path.join(dir, "t.csv");
    await writeFile(file, "رقم الصنف,اسم الصنف,الكمية\n04465-06090,فحمات,4\n");
    const res = await importStockFile(null, { shopId: "s", file, synthetic: null, dryRun: true });
    expect(res.parsed.items[0]).toMatchObject({ partNumberNormalized: "0446506090", qty: 4, isSynthetic: false });
  });
});
