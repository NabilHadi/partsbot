// Stock in the quote reply: uses the mock's TEST FIXTURE Camry (real Medrar numbers, fake vehicle).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizePartNumber, splitOem } from "../inventory/normalize.js";
import { createStockLookup, InMemoryStockSource, type StockRow } from "../inventory/stock.js";
import { STOCK_TEST_VIN } from "../mock/stock-test-fixtures.js";
import { Conversation } from "./conversation-driver.js";
import { findPartNumberLikeTokens } from "./guard.js";
import { recording, startMock } from "./testkit.js";

let mock: Awaited<ReturnType<typeof startMock>>;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(async () => {
  await mock.close();
});

const IMPORTED = new Date("2026-10-24T12:00:00+03:00"); // conversation clock starts 2026-10-25 09:00 Riyadh
function row(raw: string, qty: number | null, priceSar: number | null, extra: Partial<StockRow> = {}): StockRow & { shopId: string } {
  const { oemBase, suffix } = splitOem(raw);
  return {
    shopId: "shop_1", partNumberRaw: raw, partNumberNormalized: normalizePartNumber(raw), oemBase, variantSuffix: suffix,
    qty, priceSar, vatIncluded: true, isSynthetic: false, active: true, importedAt: IMPORTED, ...extra,
  };
}
const PADS = [row("04465-06090", 3, 240), row("04465-06090-J", 2, 180), row("04465-06090-CH", 0, 95), row("04465-06090-E", 5, 120)];

function conv(rows: (StockRow & { shopId: string })[], shop: Record<string, unknown> = {}, allowSynthetic = false) {
  const rec = recording(mock.client);
  const c = new Conversation(rec, shop);
  c.extras = { stock: createStockLookup(new InMemoryStockSource(rows), "shop_1", allowSynthetic), allowSyntheticStock: allowSynthetic };
  return { c, rec };
}
const ASK = `${STOCK_TEST_VIN} فحمات فرامل امامية`;

describe("stock in the quote", () => {
  it("one reply: part number, availability of the same number and variants, freshness; no price by default", async () => {
    const { c, rec } = conv(PADS);
    const r = await c.say(ASK);
    expect(r.replies).toHaveLength(1);
    const text = r.replies[0]!;
    expect(text).toContain("04465-06090");
    expect(text).toContain("نفس الرقم: متوفر (3)");
    expect(text).toContain("بدائل بنفس الرقم الأساسي:");
    expect(text).toContain("- ياباني (J): متوفر (2)");
    expect(text).toContain("- رمز E (غير مؤكد): متوفر (5)");
    expect(text).toContain("- صيني (CH): غير متوفر حالياً");
    expect(text.indexOf("ياباني (J)")).toBeLessThan(text.indexOf("رمز E")); // in stock: origin before unknown
    expect(text.indexOf("رمز E")).toBeLessThan(text.indexOf("صيني (CH)")); // out of stock last
    expect(text).toContain("المخزون حسب تحديث 2026-10-24.");
    expect(text).toContain("الموظف يؤكد لك التوفر");
    expect(text).not.toMatch(/ريال|اصلي|أصلي|تجريبية/);
    for (const tok of findPartNumberLikeTokens(text)) expect(rec.partNumbers.has(tok), tok).toBe(true);
  });

  it("prices only when priceQuotingEnabled, with the VAT note", async () => {
    const { c } = conv(PADS, { priceQuotingEnabled: true });
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain("نفس الرقم: متوفر (3) · 240 ريال");
    expect(text).toContain("- ياباني (J): متوفر (2) · 180 ريال");
    expect(text).toContain("الأسعار شاملة الضريبة.");
  });

  it("brand suffix shows the brand name", async () => {
    const { c } = conv([row("17801-0H030-DENSO", 4, null)]);
    const text = (await c.say(`${STOCK_TEST_VIN} فلتر هواء`)).replies[0]!;
    expect(text).toContain("17801-0H030");
    expect(text).toContain("- DENSO: متوفر (4)");
    expect(text).not.toContain("نفس الرقم:");
  });

  it("no stock row keeps the old line", async () => {
    const { c } = conv([]);
    const text = (await c.say(`${STOCK_TEST_VIN} فلتر زيت`)).replies[0]!;
    expect(text).toContain("90915-YZZE1");
    expect(text).toContain("الموظف يؤكد لك التوفر.");
    expect(text).not.toMatch(/متوفر \(|المخزون حسب/);
  });

  it("stale data: date and staff confirm, no quantities or prices", async () => {
    const old = PADS.map((r) => ({ ...r, importedAt: new Date("2026-10-01T09:00:00+03:00") }));
    const { c } = conv(old, { priceQuotingEnabled: true });
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain("بيانات المخزون قديمة (آخر تحديث 2026-10-01)، الموظف يؤكد لك التوفر.");
    expect(text).not.toMatch(/متوفر \(|ريال/);
  });

  it("lookup failure: quote still goes out, staff alerted", async () => {
    const c = new Conversation(mock.client, {});
    c.extras = { stock: async () => { throw new Error("db down SECRET"); } };
    const r = await c.say(ASK);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("04465-06090");
    expect(r.replies[0]).toContain("الموظف يؤكد لك التوفر.");
    expect(r.replies[0]).not.toContain("SECRET");
    expect(r.actions).toContainEqual(expect.objectContaining({ type: "alert", code: "stock_lookup_failed" }));
  });
});

describe("synthetic stock never reaches a real customer", () => {
  const SYN = PADS.map((r) => ({ ...r, isSynthetic: true }));

  it("not allowed: synthetic rows count as missing", async () => {
    const { c } = conv(SYN, { priceQuotingEnabled: true }, false);
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).not.toMatch(/متوفر \(|ريال|تجريبية|المخزون حسب/);
    expect(text).toContain("الموظف يؤكد لك التوفر.");
  });

  it("even if a lookup leaks synthetic data, the engine drops it without the flag", async () => {
    const c = new Conversation(mock.client, {});
    const leaky = createStockLookup(new InMemoryStockSource(SYN), "shop_1", true);
    c.extras = { stock: leaky, allowSyntheticStock: false };
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).not.toMatch(/متوفر \(|تجريبية/);
  });

  it("allowed (test shop): shown and marked (بيانات تجريبية)", async () => {
    const { c } = conv(SYN, { priceQuotingEnabled: true }, true);
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain("نفس الرقم: متوفر (3) · 240 ريال");
    expect(text).toContain("(بيانات تجريبية)");
  });
});
