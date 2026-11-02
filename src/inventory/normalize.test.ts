import { describe, expect, it } from "vitest";
import {
  describeSuffix,
  extractAltNumbers,
  isPhoneLikeItemNumber,
  nameContainsPhone,
  normalizePartNumber,
  placeholderReason,
  splitOem,
} from "./normalize.js";

describe("normalizePartNumber", () => {
  it.each([
    ["04465-0K290", "044650K290"],
    ["04111-25091.", "0411125091"],
    ["*16400-F2050", "16400F2050"],
    ["  90915-yzze1 ", "90915YZZE1"],
    ["٠٤٤٦٥-٠K٢٩٠", "044650K290"], // Arabic-Indic digits
    ["96301-3XZ0ِA-TW", "963013XZ0ATW"], // stray kasra inside the number
    ["04465 0K290", "044650K290"],
    ["０４４６５-０Ｋ２９０", "044650K290"], // full-width (NFKC)
  ])("%s -> %s", (raw, want) => expect(normalizePartNumber(raw)).toBe(want));
});

describe("splitOem", () => {
  it.each([
    ["04465-06090", "0446506090", null],
    ["04465-06090-J", "0446506090", "J"],
    ["04465-06090K", "0446506090", "K"],
    ["04465-06090-CH.", "0446506090", "CH"],
    ["17801-0H030-DENSO", "178010H030", "DENSO"],
    ["89341-60060-A0-J", "8934160060", "A0-J"],
    ["0411122700", "0411122700", null],
    ["58101-D3A10", "58101D3A10", null],
  ])("%s -> base %s suffix %s", (raw, base, suffix) => expect(splitOem(raw)).toEqual({ oemBase: base, suffix }));

  it("shop codes and short numbers have no base", () => {
    expect(splitOem("X1234")).toEqual({ oemBase: null, suffix: null });
    expect(splitOem("022510-4170-J").oemBase).toBeNull();
    expect(splitOem("00000-000").oemBase).toBeNull();
  });
});

describe("describeSuffix (Nabil: origin / brand / unknown; plain number is NOT 'genuine')", () => {
  it("origins", () => {
    expect(describeSuffix("CH")).toMatchObject({ kind: "origin", labelAr: "صيني", unconfirmed: false });
    expect(describeSuffix("J")).toMatchObject({ kind: "origin", labelAr: "ياباني" });
    expect(describeSuffix("TH")).toMatchObject({ kind: "origin", labelAr: "تايلندي" });
    expect(describeSuffix("TW")).toMatchObject({ kind: "origin", labelAr: "تايواني" });
  });
  it("brands show the brand name", () => {
    expect(describeSuffix("DENSO")).toMatchObject({ kind: "brand", labelAr: "DENSO", brand: "DENSO" });
    expect(describeSuffix("KYB")).toMatchObject({ kind: "brand", labelAr: "KYB" });
    expect(describeSuffix("AISN")).toMatchObject({ kind: "brand", labelAr: "AISIN" });
  });
  it("unknown suffixes stay raw and unconfirmed", () => {
    expect(describeSuffix("E")).toMatchObject({ kind: "unknown", labelAr: "E", unconfirmed: true, brand: null });
    expect(describeSuffix("A0")).toMatchObject({ kind: "unknown", unconfirmed: true });
  });
  it("compound suffix: last known token decides, flagged unconfirmed", () => {
    expect(describeSuffix("A0-J")).toMatchObject({ kind: "origin", labelAr: "ياباني", unconfirmed: true });
  });
  it("no suffix is 'none', never labelled genuine", () => {
    const d = describeSuffix(null);
    expect(d.kind).toBe("none");
    expect(JSON.stringify(d)).not.toContain("اصلي");
  });
});

describe("extractAltNumbers", () => {
  it("finds OEM-style numbers in names, minus its own", () => {
    expect(extractAltNumbers("(0H030)  فلتر 17801-28030 كامري 17801-0H030", "178010H030")).toEqual(["1780128030"]);
    expect(extractAltNumbers("فلتر هواء كامري 2007-2017", "178010H030")).toEqual([]);
  });
});

describe("PII and placeholders", () => {
  it("phone numbers used as item numbers", () => {
    expect(isPhoneLikeItemNumber("0551234567")).toBe(true);
    expect(isPhoneLikeItemNumber("+966551234567")).toBe(true);
    expect(isPhoneLikeItemNumber("00966551234567")).toBe(true);
    expect(isPhoneLikeItemNumber("٠٥٥١٢٣٤٥٦٧")).toBe(true);
    expect(isPhoneLikeItemNumber("551234567")).toBe(true); // no leading 0: still treated as a phone (safe side)
    expect(isPhoneLikeItemNumber("05512-34567")).toBe(false); // dashed = part-number shape
    expect(isPhoneLikeItemNumber("0411122700")).toBe(false);
    expect(isPhoneLikeItemNumber("04465-0K290")).toBe(false);
  });
  it("names containing a phone number", () => {
    expect(nameContainsPhone("محمد 0551234567")).toBe(true);
    expect(nameContainsPhone("محمد 055 123 4567")).toBe(true);
    expect(nameContainsPhone("ابو فهد ٠٥٥١٢٣٤٥٦٧")).toBe(true);
    expect(nameContainsPhone("فلتر هواء كامري 2007-2017")).toBe(false);
    expect(nameContainsPhone("(66-20110)فحمات خلفيه")).toBe(false);
  });
  it("placeholders and mangled numbers", () => {
    expect(placeholderReason(".")).toBe("placeholder_part_number");
    expect(placeholderReason("00000-00000")).toBe("placeholder_part_number");
    expect(placeholderReason("00000-000")).toBe("placeholder_part_number");
    expect(placeholderReason("حساس")).toBe("placeholder_part_number");
    expect(placeholderReason("1.172-13E+11")).toBe("spreadsheet_number_mangled");
    expect(placeholderReason("")).toBe("empty_part_number");
    expect(placeholderReason("04465-0K290")).toBeNull();
    expect(placeholderReason("90915-YZZE1")).toBeNull(); // has an E but is a real number
  });
});
