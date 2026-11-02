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
