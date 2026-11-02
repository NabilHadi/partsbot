// Per-shop display settings and opening hours, end to end through the engine (mock OneEPC + in-memory stock).
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

const IMPORTED = new Date("2026-10-24T12:00:00+03:00");
function row(raw: string, qty: number | null, priceSar: number | null): StockRow & { shopId: string } {
  const { oemBase, suffix } = splitOem(raw);
  return {
    shopId: "shop_1", partNumberRaw: raw, partNumberNormalized: normalizePartNumber(raw), oemBase, variantSuffix: suffix,
    qty, priceSar, vatIncluded: true, isSynthetic: false, active: true, importedAt: IMPORTED,
  };
}
const PADS = [row("04465-06090", 3, 240), row("04465-06090-J", 2, 180), row("04465-06090-CH", 0, 95), row("04465-06090-E", 5, 120)];
const ONLY_VARIANTS = [row("04465-06090-J", 2, 180)];
const ASK = `${STOCK_TEST_VIN} فحمات فرامل امامية`;
const PN = "04465-06090";

// Friday split shift 08-12 / 16-23, Thursday until midnight (24:00), Saturday from 08:00.
const HOURS = {
  days: {
    thu: [{ open: "16:00", close: "24:00" }],
    fri: [{ open: "08:00", close: "12:00" }, { open: "16:00", close: "23:00" }],
    sat: [{ open: "08:00", close: "22:00" }],
  },
};

function conv(shop: Record<string, unknown>, rows = PADS, start?: string) {
  const rec = recording(mock.client);
  const c = new Conversation(rec, shop, start ? new Date(`${start}+03:00`) : undefined);
  c.extras = { stock: createStockLookup(new InMemoryStockSource(rows), "shop_1", false), allowSyntheticStock: false };
  return { c, rec };
}

describe("part numbers hidden", () => {
  it("names the part only, still shows stock (quantity mode), logs the number for staff", async () => {
    const { c } = conv({ showPartNumbers: false, stockDisplay: "quantity" });
    const r = await c.say(ASK);
    expect(r.replies).toHaveLength(1);
    const text = r.replies[0]!;
    expect(text).not.toContain("04465");
    expect(findPartNumberLikeTokens(text)).toEqual([]);
    expect(text).toContain("حسب الكتالوج، القطعة المناسبة لسيارتك:");
    expect(text).toMatch(/• [^\n:]*فحمات/); // Arabic catalogue name, no number
    expect(text).toContain("نفس القطعة: متوفر (3)");
    expect(text).toContain("بدائل للقطعة نفسها:");
    expect(text).toContain("- ياباني: متوفر (2)");
    expect(text).toContain("- بديل آخر (غير مؤكد): متوفر (5)");
    expect(text).not.toMatch(/\(J\)|\(CH\)|رمز E/); // suffix codes go with the number
    expect(r.actions).toContainEqual({ type: "parts_identified", partNumbers: [PN], shownToCustomer: false });
    expect(r.newState.lastParts).toEqual([PN]);
  });
  it("availability mode: in / out only, never a count", async () => {
    const { c } = conv({ showPartNumbers: false, stockDisplay: "availability" });
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain("نفس القطعة: متوفر");
    expect(text).toContain("- صيني: غير متوفر حالياً");
    expect(text).not.toMatch(/متوفر \(\d/);
    expect(text).not.toMatch(/[0-9٠-٩]+\)/);
  });
});

describe("stock display and alternatives", () => {
  it("default config: number shown, availability only, alternatives on, no price", async () => {
    const { c } = conv({});
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain(PN);
    expect(text).toContain("نفس الرقم: متوفر\n");
    expect(text).toContain("- ياباني (J): متوفر");
    expect(text).not.toMatch(/متوفر \(\d|ريال/);
  });
  it("stock hidden, prices off: no stock line, no lookup wording beyond 'staff confirm'", async () => {
    const { c } = conv({ stockDisplay: "hidden" });
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain(PN);
    expect(text).not.toMatch(/متوفر|بدائل|المخزون|ريال/);
    expect(text).toContain("الموظف يؤكد لك التوفر.");
  });
  it("stock hidden, prices on: the price without availability", async () => {
    const { c } = conv({ stockDisplay: "hidden", priceQuotingEnabled: true });
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain("نفس الرقم: السعر 240 ريال");
    expect(text).not.toMatch(/متوفر/);
    expect(text).toContain("الأسعار حسب تحديث 2026-10-24. الأسعار شاملة الضريبة. الموظف يؤكد لك التوفر والسعر.");
  });
  it("alternatives off: only the same number", async () => {
    const { c } = conv({ showAlternatives: false, stockDisplay: "quantity" });
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain("نفس الرقم: متوفر (3)");
    expect(text).not.toMatch(/بدائل|ياباني|صيني|رمز E/);
  });
  it("alternatives off and only alternatives in stock: no stock line at all (not 'out of stock')", async () => {
    const { c } = conv({ showAlternatives: false }, ONLY_VARIANTS);
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).not.toMatch(/متوفر|ياباني|المخزون/);
    expect(text).toContain("الموظف يؤكد لك التوفر.");
  });
  it("everything visible (the local test shop): number, quantity, alternatives, prices", async () => {
    const { c } = conv({ showPartNumbers: true, stockDisplay: "quantity", showAlternatives: true, priceQuotingEnabled: true });
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain(PN);
    expect(text).toContain("نفس الرقم: متوفر (3) · 240 ريال");
    expect(text).toContain("- ياباني (J): متوفر (2) · 180 ريال");
  });
});

describe("after hours", () => {
  it("reply_with_note (default): normal reply plus ONE note with the next opening (Friday break between shifts)", async () => {
    const { c, rec } = conv({ businessHours: HOURS }, PADS, "2026-10-30T12:29:00"); // Friday 12:30 after the first say
    const r = await c.say(ASK);
    expect(r.replies).toHaveLength(1);
    const text = r.replies[0]!;
    expect(text).toContain(PN);
    expect(text).toMatch(/⏰ المحل مسكّر الحين، والموظف بيتابع معك اليوم الساعة 4:00 عصراً بإذن الله\.$/);
    expect(rec.calls).toContain("search");
    const r2 = await c.say("فلتر زيت");
    expect(r2.replies.join("")).not.toContain("مسكّر"); // once per closed period
  });
  it("reply_with_note: a new closed period gets a new note (Friday 23:00 -> Saturday 08:00 'بكرة')", async () => {
    const { c } = conv({ businessHours: HOURS }, PADS, "2026-10-30T12:29:00");
    await c.say(ASK);
    await c.say("فلتر زيت", 60 * 4); // 16:30: open
    const r = await c.say("فلتر هواء", 60 * 7); // 23:30: closed again
    expect(r.replies[0]).toContain("بكرة الساعة 8:00 صباحاً");
  });
  it("midnight boundary: Thursday 23:59 is open (no note), Friday 00:00 is closed until 08:00", async () => {
    const open = conv({ businessHours: HOURS }, PADS, "2026-10-29T23:58:00");
    expect((await open.c.say(ASK)).replies[0]).not.toContain("مسكّر");
    const closed = conv({ businessHours: HOURS }, PADS, "2026-10-29T23:59:00");
    expect((await closed.c.say(ASK)).replies[0]).toContain("المحل مسكّر الحين، والموظف بيتابع معك اليوم الساعة 8:00 صباحاً");
  });
  it("handoff replies after hours carry the follow-up time once, no extra note", async () => {
    const { c } = conv({ businessHours: HOURS }, PADS, "2026-10-30T12:29:00");
    const text = (await c.say("ابي اكلم موظف")).replies[0]!;
    expect(text).toContain("الموظف بيرد عليك اليوم الساعة 4:00 عصراً");
    expect(text).not.toContain("مسكّر");
  });
  it("note_only: only the note (no OneEPC call), then silence while closed, normal service once open", async () => {
    const { c, rec } = conv({ businessHours: HOURS, afterHoursMode: "note_only", shopName: "قطع غيار الأمل" }, PADS, "2026-10-30T12:29:00");
    const r = await c.say(ASK);
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0]).toContain("قطع غيار الأمل مسكّر الحين، والموظف بيتابع معك اليوم الساعة 4:00 عصراً");
    expect(r.replies[0]).not.toContain(PN);
    expect(rec.calls).toEqual([]);
    expect(r.actions).toContainEqual({ type: "customer_waiting" });
    const r2 = await c.say("فيه احد؟");
    expect(r2.replies).toEqual([]);
    const r3 = await c.say(ASK, 60 * 4); // 16:30, open
    expect(r3.replies[0]).toContain(PN);
    expect(r3.replies[0]).not.toContain("مسكّر");
  });
  it("English, language fixed to en", async () => {
    const { c } = conv({ businessHours: HOURS, language: "en" }, PADS, "2026-10-30T12:29:00");
    const text = (await c.say(ASK)).replies[0]!;
    expect(text).toContain("⏰ The shop is closed now; our staff will follow up today at 4:00 PM.");
  });
});

describe("language", () => {
  it("default ar: an English message still gets Arabic", async () => {
    const { c } = conv({});
    const r = await c.say("hi, I need front brake pads");
    expect(r.replies[0]).toMatch(/[\u0600-\u06FF]/);
  });
});

describe("staff numbers stay private", () => {
  it("are never sent to the OneEPC gateway nor shown to the customer", async () => {
    const STAFF = "+966551239876";
    const sent: string[] = [];
    const inner = mock.client;
    const spy = {
      async decode(vin: string) { sent.push(JSON.stringify(vin)); return inner.decode(vin); },
      async searchParts(id: Parameters<typeof inner.searchParts>[0], p: Parameters<typeof inner.searchParts>[1]) { sent.push(JSON.stringify([id, p])); return inner.searchParts(id, p); },
    };
    const c = new Conversation(spy, { staff: [{ name: "أبو فهد", phone: STAFF }], staffHandoffName: "أبو فهد" });
    c.extras = { stock: createStockLookup(new InMemoryStockSource(PADS), "shop_1", false), allowSyntheticStock: false };
    const r1 = await c.say(ASK);
    const r2 = await c.say("ابي اكلم موظف");
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s).not.toMatch(/551239876|9876/);
    for (const t of [...r1.replies, ...r2.replies]) expect(t).not.toContain("551239876");
  });
});
