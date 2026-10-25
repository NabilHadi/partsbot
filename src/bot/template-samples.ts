// Sample parameters to render every template (docs generator and tests). Fake data only.
import { staffFollowUp } from "./arabic.js";
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
  };
}
