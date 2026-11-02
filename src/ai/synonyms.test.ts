import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SYNONYM_SEED } from "./synonym-seed.js";
import { SynonymIndex, queryForAiPart, synonymKey } from "./synonyms.js";

const SEED = SYNONYM_SEED.map(([term, canonicalAr, canonicalEn]) => ({ term, canonicalAr, canonicalEn }));
const index = new SynonymIndex(SEED);
const part = (o: Partial<{ customer_words: string; normalized_en: string; normalized_ar: string; position: "front" | "rear" | "left" | "right" | null }>) => ({
  customer_words: "", normalized_en: "", normalized_ar: "", position: null, qty: null, ...o,
});

describe("synonym list (deterministic layer)", () => {
  it("migration 006 seeds exactly SYNONYM_SEED with the same keys", () => {
    const sql = readFileSync(new URL("../db/migrations/006_synonyms.sql", import.meta.url), "utf8");
    for (const s of SEED) expect(sql, s.term).toContain(`'${synonymKey(s.term).replace(/'/g, "''")}'`);
    expect(new Set(SEED.map((s) => synonymKey(s.term))).size).toBe(SEED.length);
  });

  it("rewrites slang to the catalogue name, keeps the rest", () => {
    expect(index.rewrite("قماشات قدام").text).toBe("فحمات فرامل قدام");
    expect(index.rewrite("قماشات فرامل").text).toBe("فحمات فرامل");
    expect(index.rewrite("وكفرات").hits.length).toBe(1);
    expect(index.rewrite("دبة الماي").hits).toEqual([]);
  });

  it("table hit on the customer's words: filler and 'تبع المكينة' are dropped, English comes from the table (pipe-05)", () => {
    const q = queryForAiPart(part({ customer_words: "فلتر الهوا تبع المكينة", normalized_ar: "فلتر هواء المحرك", normalized_en: "engine air filter" }), index);
    expect(q).toMatchObject({ query: "فلتر هواء", queryEn: "air filter", source: "table", suggestion: null });
    const q2 = queryForAiPart(part({ customer_words: "ابي كرتون الزيت حق الجيب", normalized_ar: "فلتر زيت", normalized_en: "oil filter" }), index);
    expect(q2).toMatchObject({ query: "فلتر زيت", queryEn: "oil filter", source: "table" });
  });

  it("queryEn: the model's English name when the table does not know the words; position in both languages", () => {
    const q = queryForAiPart(part({ customer_words: "دبة الماي", normalized_ar: "خزان ماء الغسيل", normalized_en: "washer reservoir" }), index);
    expect(q).toMatchObject({ query: "خزان ماء الغسيل", queryEn: "washer reservoir", source: "ai" });
    const r = queryForAiPart(part({ customer_words: "قماشات ورا", normalized_ar: "بطانات فرامل", normalized_en: "brake linings", position: "rear" }), index);
    expect(r.queryEn).toBe("rear brake pads");
    const en = queryForAiPart(part({ customer_words: "wiper blade", normalized_en: "wiper blade" }), null);
    expect(en).toMatchObject({ query: "wiper blade", queryEn: null }); // same text: no point sending it twice
  });

  it("the list beats the AI: a known customer word wins over the model's name", () => {
    const q = queryForAiPart(part({ customer_words: "قماشات ورا", normalized_ar: "بطانات فرامل", normalized_en: "brake linings", position: "rear" }), index);
    expect(q).toMatchObject({ query: "فحمات فرامل خلفية", source: "table", suggestion: null });
  });

  it("an unknown word mapped by the AI becomes a pending suggestion (never applied by itself)", () => {
    const q = queryForAiPart(part({ customer_words: "بوجيات قدام", normalized_ar: "بواجي", normalized_en: "spark plugs", position: "front" }), index);
    expect(q).toMatchObject({ query: "بواجي أمامية", source: "table", suggestion: { term: "بوجيات", canonicalAr: "بواجي" } }); // normalized_ar hits the list
    const q2 = queryForAiPart(part({ customer_words: "دبة الماي", normalized_ar: "خزان ماء الغسيل", normalized_en: "washer reservoir" }), index);
    expect(q2).toMatchObject({ query: "خزان ماء الغسيل", source: "ai", suggestion: { term: "دبة الماي", canonicalAr: "خزان ماء الغسيل", canonicalEn: "washer reservoir" } });
    expect(index.has("دبة الماي")).toBe(false);
  });

  it("never suggests part numbers", () => {
    const q = queryForAiPart(part({ customer_words: "04465-06090", normalized_ar: "فحمات فرامل" }), index);
    expect(q.suggestion).toBeNull();
  });
});
