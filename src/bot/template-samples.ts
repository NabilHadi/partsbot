// Sample parameters to render every template (docs generator and tests). Fake data only.
import { staffFollowUp, whenText, type PartLine, type StockFooter } from "./arabic.js";
import { DEFAULT_SHOP_CONFIG } from "./shop-config.js";
import type { Lang } from "./intent.js";

export function sampleParams(lang: Lang): Record<string, unknown> {
  const ar = lang === "ar";
  return {
    shopName: "",
    followUp: staffFollowUp(lang, DEFAULT_SHOP_CONFIG, { open: true }),
    vehicle: ar ? "Toyota لاند كروزر 2022 GXR" : "Toyota Land Cruiser 2022 GXR",
    question: ar ? "هل الفرامل الأمامية مقاس 17 أو 18 إنش؟" : "Are the front brakes 17 or 18 inch?",
    options: ar ? ["Toyota هايلكس 2020 — 2.7L petrol", "Toyota هايلكس 2020 — 4.0L V6 petrol"] : ["Toyota Hilux 2020 — 2.7L petrol", "Toyota Hilux 2020 — 4.0L V6 petrol"],
    items: [{ name: ar ? "فلتر زيت" : "Filter, oil", partNumber: "00000-EXAMPLE4" }],
    staffNote: false,
    askAck: true,
    problem: "bad_length",
    when: whenText(lang, { dayOffset: 1, weekday: "sat", time: "09:00" }),
  };
}

/**
 * partsQuoted as each stock/part-number setting renders it (docs only). Fake numbers and synthetic-looking
 * stock; prices appear only in the "prices on" sample.
 */
export function partsQuotedSettingSamples(lang: "ar" | "en"): { title: string; params: { items: PartLine[]; staffNote: boolean; askAck: boolean; stock: StockFooter | null } }[] {
  const ar = lang === "ar";
  const name = ar ? "فحمات فرامل أمامية" : "Pad kit, disc brake, front";
  const variant = (price: number | null) => ({ kind: "origin" as const, code: "J", labelAr: "ياباني", labelEn: "Japanese", unconfirmed: false, qty: 2, priceSar: price });
  const footer = (o: Partial<StockFooter>): StockFooter => ({ asOf: "2026-10-28", stale: false, synthetic: false, pricesShown: false, stockShown: true, ...o });
  const item = (display: "hidden" | "availability" | "quantity", showNumber: boolean, alternatives: boolean, prices: boolean): PartLine => ({
    name,
    partNumber: showNumber ? "00000-EXAMPLE1" : null,
    stock: { display, exact: { qty: 4, priceSar: prices ? 240 : null }, variants: alternatives ? [variant(prices ? 180 : null)] : [] },
  });
  const base = { staffNote: false, askAck: false };
  return [
    { title: "defaults: numbers shown, stockDisplay=availability, alternatives on, prices off", params: { ...base, items: [item("availability", true, true, false)], stock: footer({}) } },
    { title: "stockDisplay=quantity, prices on", params: { ...base, items: [item("quantity", true, true, true)], stock: footer({ pricesShown: true }) } },
    { title: "showPartNumbers=false, stockDisplay=quantity (number logged for staff only)", params: { ...base, items: [item("quantity", false, true, false)], stock: footer({}) } },
    { title: "showAlternatives=false", params: { ...base, items: [item("availability", true, false, false)], stock: footer({}) } },
    { title: "stockDisplay=hidden, prices off (no stock lookup at all)", params: { ...base, items: [{ name, partNumber: "00000-EXAMPLE1" }], stock: null } },
  ];
}
