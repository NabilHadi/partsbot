/**
 * Read a stock file as plain cell text, row by row. DATA ONLY:
 *  - .xlsx / .xlsm are read with ExcelJS's streaming reader, which parses the XML parts only. VBA projects
 *    (xl/vbaProject.bin) are never read or executed; formulas yield their cached result, never re-evaluated.
 *  - .csv is parsed in-process (RFC 4180 quoting, UTF-8 with or without BOM).
 * Rows are 1-based arrays of trimmed strings (index 0 unused, like Excel column numbers), with `rowNumber`
 * matching the spreadsheet row so rejects can point at it.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

export interface SheetRow {
  rowNumber: number;
  cells: string[];
}

export type SourceKind = "xlsx" | "csv";

export function sourceKindFor(file: string): SourceKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".xlsx" || ext === ".xlsm") return "xlsx";
  if (ext === ".csv") return "csv";
  throw new Error(`unsupported file type ${ext || "(none)"}: use .xlsx, .xlsm or .csv`);
}

/** Text of one ExcelJS cell value (rich text, formula result, hyperlink text, dates as ISO). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("").trim();
    if ("result" in o) return cellText(o.result); // formula: cached value only
    if ("text" in o) return cellText(o.text);
    if ("error" in o) return "";
  }
  return String(v).trim();
}

export async function* readXlsxRows(file: string): AsyncGenerator<SheetRow> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(createReadStream(file), {
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
    entries: "emit",
  });
  let sheets = 0;
  for await (const ws of reader) {
    if (sheets++ > 0) break; // first worksheet only (the Medrar export has one)
    for await (const row of ws as AsyncIterable<ExcelJS.Row>) {
      const values = row.values as unknown[];
      const cells: string[] = [];
      for (let i = 1; i < values.length; i++) cells[i] = cellText(values[i]);
      yield { rowNumber: row.number, cells };
    }
  }
}

/** Minimal RFC 4180 CSV parser (quotes, doubled quotes, CRLF/LF, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function* readCsvRows(file: string): AsyncGenerator<SheetRow> {
  const rows = parseCsv(await readFile(file, "utf8"));
  for (const [i, r] of rows.entries()) yield { rowNumber: i + 1, cells: [""].concat(r.map((x) => x.trim())) };
}

export function readRows(file: string): AsyncGenerator<SheetRow> {
  return sourceKindFor(file) === "xlsx" ? readXlsxRows(file) : readCsvRows(file);
}
