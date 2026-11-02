import { describe, expect, it } from "vitest";
import { composeReply } from "./compose.js";
import { selectCandidates } from "./select.js";
import { draftOf, failWith, scriptedProvider } from "./testkit.js";
import { PARTS_PLACEHOLDER as P } from "./validate.js";

const candidates = [
  { index: 0, nameAr: "فحمات فرامل أمامية", nameEn: "Pad kit, front", category: "Brakes" },
  { index: 1, nameAr: "فحمات فرامل خلفية", nameEn: "Pad kit, rear", category: "Brakes" },
];
const sel = { lang: "ar" as const, customerText: "ابي فحمات ورا", query: "فحمات فرامل", candidates };

describe("selectCandidates (AI may only pick by index or ask)", () => {
  it("keeps valid indexes", async () => {
    const r = await selectCandidates(scriptedProvider(() => ({ keep: [1], question: null })), sel);
    expect(r).toMatchObject({ ok: true, keep: [1], question: null });
  });
  it("an index outside the list fails the whole call", async () => {
    expect(await selectCandidates(scriptedProvider(() => ({ keep: [7], question: null })), sel)).toMatchObject({ ok: false, reason: "invalid_index" });
  });
  it("a question with numbers or prices is dropped -> nothing_selected", async () => {
    expect(await selectCandidates(scriptedProvider(() => ({ keep: [], question: "تبي رقم 04465-06090؟" })), sel)).toMatchObject({ ok: false, reason: "nothing_selected" });
    const ok = await selectCandidates(scriptedProvider(() => ({ keep: [], question: "تبي الأمامية ولا الخلفية؟" })), sel);
    expect(ok).toMatchObject({ ok: true, keep: [], question: "تبي الأمامية ولا الخلفية؟" });
  });
});

describe("composeReply", () => {
  const input = { lang: "ar" as const, shopName: "محل", customerText: "السلام", draft: `سيارتك كامري 2014\n${P}\nتبي شي ثاني؟` };
  it("returns a validated rewrite", async () => {
    const p = scriptedProvider((req) => ({ reply: `وعليكم السلام! ${draftOf(req)}` }));
    const r = await composeReply(p, input);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.text).toContain(P);
  });
  it("a rewrite that adds a price is rejected with the validator reason", async () => {
    const r = await composeReply(scriptedProvider(() => ({ reply: `سيارتك كامري 2014\n${P}\nالسعر 150 ريال` })), input);
    expect(r).toMatchObject({ ok: false, reason: "validator", validator: "new_number" });
  });
  it("provider failure -> reason code", async () => {
    expect(await composeReply(scriptedProvider(failWith("overloaded")), input)).toMatchObject({ ok: false, reason: "overloaded" });
  });
});
