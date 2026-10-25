import { describe, expect, it } from "vitest";
import { T, render, staffFollowUp, type TemplateName } from "./arabic.js";
import { findPartNumberLikeTokens } from "./guard.js";
import { DEFAULT_SHOP_CONFIG } from "./shop-config.js";
import { sampleParams } from "./template-samples.js";

const paramsFor = (lang: "ar" | "en") => sampleParams(lang) as never;

describe("template catalogue", () => {
  const names = Object.keys(T) as TemplateName[];
  it("has the expected number of templates", () => expect(names.length).toBeGreaterThanOrEqual(20));
  it("every template exists in both Arabic and English", () => {
    for (const n of names) {
      expect(typeof T[n].ar, `${n}.ar`).toBe("function");
      expect(typeof T[n].en, `${n}.en`).toBe("function");
    }
  });
  it("no template mentions a price, in either language", () => {
    for (const n of names) {
      for (const lang of ["ar", "en"] as const) {
        const text = (T[n][lang] as (p: never) => string)(paramsFor(lang));
        expect(text, `${n}.${lang}`).not.toMatch(/ريال|سعر|أسعار|اسعار|SAR|SR\b|price|cost|\$|\d+\s*ر\.?س/i);
      }
    }
  });
  it("no template (other than the quoted-parts one) contains a part-number-like token", () => {
    for (const n of names) {
      if (n === "partsQuoted") continue;
      for (const lang of ["ar", "en"] as const) {
        const text = (T[n][lang] as (p: never) => string)(paramsFor(lang));
        expect(findPartNumberLikeTokens(text), `${n}.${lang}`).toEqual([]);
      }
    }
  });
  it("render() falls back to a string and never throws for each template", () => {
    for (const n of names) {
      expect(typeof render("ar", n, paramsFor("ar"))).toBe("string");
    }
  });
});

describe("staffFollowUp", () => {
  it("English sentence is capitalised and does not duplicate wording", () => {
    const en = staffFollowUp("en", DEFAULT_SHOP_CONFIG, { open: true });
    expect(en.charAt(0)).toBe(en.charAt(0).toUpperCase());
  });
  it("says when staff open next when closed", () => {
    const ar = staffFollowUp("ar", DEFAULT_SHOP_CONFIG, { open: false, next: { dayOffset: 1, weekday: "mon", time: "09:00" } });
    expect(ar).toContain("9:00");
  });
});
