import { describe, expect, it } from "vitest";
import { CONFIRM_WITH_STAFF_AR } from "../bot/arabic.js";
import { PARTS_PLACEHOLDER as P, validateReply } from "./validate.js";

const draft = `تمام، سيارتك تويوتا لاند كروزر 2022.\n${P}\nيرجى التأكيد مع الموظف قبل الشراء.`;
const v = (out: string, d = draft, lang: "ar" | "en" = "ar") => validateReply(out, d, lang).failure;

describe("validateReply", () => {
  it("accepts a faithful rewrite", () => {
    expect(v(`هلا والله! سيارتك تويوتا لاند كروزر 2022 👍\n${P}\nيرجى التأكيد مع الموظف قبل الشراء.`)).toBeNull();
  });
  it("rejects a dropped / duplicated parts block", () => {
    expect(v("هلا والله، سيارتك تويوتا لاند كروزر 2022. يرجى التأكيد مع الموظف")).toBe("placeholder");
    expect(v(`${P}\n${P} يرجى التأكيد مع الموظف`)).toBe("placeholder");
  });
  it("rejects invented part numbers, numbers, links", () => {
    expect(v(`${P}\nرقم القطعة 04465-06090 يرجى التأكيد مع الموظف 2022`)).toBe("part_number");
    expect(v(`${P}\nتوصلك خلال 3 ايام، لاند كروزر 2022 يرجى التأكيد مع الموظف`)).toBe("new_number");
    expect(v(`${P}\nشوف موقعنا www.shop.com يرجى التأكيد مع الموظف 2022`)).toBe("url");
  });
  it("rejects new topics: price, stock, delivery, warranty, discount, genuine", () => {
    for (const extra of ["السعر مناسب", "القطعة متوفرة", "نوصل لك", "عليها ضمان", "عندنا خصم", "القطعة اصلي"]) {
      expect(v(`لاند كروزر 2022 ${extra}\n${P}\nيرجى التأكيد مع الموظف`), extra).toBe("forbidden_topic");
    }
    // ...unless the draft (decided by code) already said it
    expect(v(`القطعة متوفرة ${P}`, `متوفرة عندنا ${P}`)).toBeNull();
  });
  it("the staff phrase must survive word for word", () => {
    expect(v(`سيارتك لاند كروزر 2022\n${P}\nتأكد من الموظف`)).toBe("staff_phrase_missing");
    expect(CONFIRM_WITH_STAFF_AR.length).toBeGreaterThan(0);
  });
  it("language and length", () => {
    expect(v("Your car is a Land Cruiser 2022. [[PARTS]] please confirm with staff يرجى التأكيد مع الموظف")).toBe("wrong_language");
    expect(v("Hello, send the VIN please.", "Please send your VIN.", "en")).toBeNull();
    expect(v("هلا " + "والله ".repeat(80), "ارسل رقم الهيكل")).toBe("too_long");
    expect(v("   ")).toBe("empty");
  });
});
