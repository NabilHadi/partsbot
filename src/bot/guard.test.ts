import { describe, expect, it } from "vitest";
import { PartNumberGuardError, assertOnlyAllowedPartNumbers, findPartNumberLikeTokens } from "./guard.js";

describe("findPartNumberLikeTokens", () => {
  it("finds hyphenated, long mixed and spaced part numbers", () => {
    expect(findPartNumberLikeTokens("رقم القطعة 04465-0K290 تمام")).toEqual(["04465-0K290"]);
    expect(findPartNumberLikeTokens("58101D3A00")).toEqual(["58101D3A00"]);
    expect(findPartNumberLikeTokens("04465 0K290")).toEqual(["04465 0K290"]);
    expect(findPartNumberLikeTokens("1234567890")).toEqual(["1234567890"]);
    expect(findPartNumberLikeTokens("00000-EXAMPLE1")).toEqual(["00000-EXAMPLE1"]);
  });
  it("catches Arabic-Indic digit numbers", () => {
    expect(findPartNumberLikeTokens("٠٤٤٦٥٠٦٦٦٦٦")).toEqual(["04465066666"]);
  });
  it("ignores ordinary text, years, sizes and short codes", () => {
    expect(findPartNumberLikeTokens("Toyota لاند كروزر 2022 GXR 3.5L V6 17-18 2020-2022 ✅")).toEqual([]);
    expect(findPartNumberLikeTokens("1) Toyota هايلكس 2020 — 2.7L petrol")).toEqual([]);
  });
});

describe("assertOnlyAllowedPartNumbers", () => {
  const allowed = ["00000-EXAMPLE4"];
  it("passes when every number is exactly an allowed one", () => {
    expect(() => assertOnlyAllowedPartNumbers("• فلتر زيت: 00000-EXAMPLE4", { allowed })).not.toThrow();
  });
  it("blocks an invented number", () => {
    expect(() => assertOnlyAllowedPartNumbers("• فلتر زيت: 00000-EXAMPLE9", { allowed })).toThrow(PartNumberGuardError);
  });
  it("blocks an edited / reformatted version of an allowed number", () => {
    for (const edited of ["00000EXAMPLE4", "00000 EXAMPLE4", "00000-example4", "٠٠٠٠٠-EXAMPLE4"]) {
      expect(() => assertOnlyAllowedPartNumbers(`رقم ${edited}`, { allowed })).toThrow(PartNumberGuardError);
    }
  });
  it("blocks any number when nothing is allowed", () => {
    expect(() => assertOnlyAllowedPartNumbers("04465-0K290", { allowed: [] })).toThrow(PartNumberGuardError);
  });
  it("reports only a count-friendly list of offending tokens", () => {
    try {
      assertOnlyAllowedPartNumbers("A 04465-0K290 B 1234567890", { allowed: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as PartNumberGuardError).offending).toHaveLength(2);
    }
  });
  it("ignores known-safe strings such as the shop phone number", () => {
    expect(() => assertOnlyAllowedPartNumbers("للتواصل: 0500000000", { allowed: [] })).toThrow();
    expect(() => assertOnlyAllowedPartNumbers("للتواصل: 0500000000", { allowed: [], ignore: ["0500000000"] })).not.toThrow();
  });
});
