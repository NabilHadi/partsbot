import { describe, expect, it } from "vitest";
import { cleanPartRequest, detectLang, extractVin, parseMessage, parseVariantChoice, toLatinDigits } from "./intent.js";
import type { VehicleRef } from "./state.js";

describe("toLatinDigits", () => {
  it("converts Arabic-Indic and Persian digits", () => {
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(toLatinDigits("۱۲۳")).toBe("123");
  });
});

describe("extractVin", () => {
  it("finds a plain VIN and uppercases it", () => {
    expect(extractVin("vin is jtmhv05j604123456 thanks")).toMatchObject({ vin: "JTMHV05J604123456", problem: null });
  });
  it("ignores spaces and dashes inside the VIN", () => {
    expect(extractVin("JTMHV 05J6 04-123456").vin).toBe("JTMHV05J604123456");
    expect(extractVin("jtm-hv05-j604-123456").vin).toBe("JTMHV05J604123456");
  });
  it("converts Arabic-Indic digits", () => {
    expect(extractVin("TESTLC٢٠٢٢٠٠٠٠٠٠١").vin).toBe("TESTLC20220000001");
  });
  it("rejects I, O and Q: reports bad_chars and never 'fixes' them", () => {
    for (const bad of ["TESTLC2022000000O", "TESTLC2022000000I", "TESTLC2022000000Q"]) {
      expect(extractVin(bad)).toMatchObject({ vin: null, problem: "bad_chars" });
    }
  });
  it("reports a wrong length without guessing", () => {
    expect(extractVin("TESTLC2022000001")).toMatchObject({ vin: null, problem: "bad_length" }); // 16
    expect(extractVin("TESTLC202200000012")).toMatchObject({ vin: null, problem: "bad_length" }); // 18
    // VINs only for now: frame numbers are recognised (to ask for the VIN), never decoded.
    for (const f of ["GGN120-0001234", "GGN1200001234", "KDJ150 0012345", "M900A-0123456", "فريمي GGN120-0001234"]) {
      expect(extractVin(f), f).toMatchObject({ vin: null, problem: "frame_number" });
    }
    // Part numbers are not frame numbers.
    for (const pn of ["04465-06090", "90915-YZZD1", "58101-D3A00"]) expect(extractVin(pn).problem, pn).toBeNull();
  });
  it("does not mistake normal words or short codes for a VIN attempt", () => {
    expect(extractVin("ابغى فلتر زيت لكامري 2020")).toMatchObject({ vin: null, problem: null });
    expect(extractVin("oil filter 90915-YZZD4")).toMatchObject({ vin: null, problem: null });
  });
  it("removes the VIN from the rest of the text", () => {
    expect(extractVin("فلتر زيت TESTLC20220000001").rest).toBe("فلتر زيت");
  });
});

describe("detectLang", () => {
  it("goes by the dominant script", () => {
    expect(detectLang("ابغى فلتر")).toBe("ar");
    expect(detectLang("need a brake pad")).toBe("en");
    expect(detectLang("2020")).toBeNull();
  });
});

describe("parseMessage", () => {
  it("strips greeting, filler, model and year from the part request", () => {
    const p = parseMessage("السلام عليكم ابغى فحمات قدام لكامري ٢٠٢٠");
    expect(p.partRequest).toBe("فحمات قدام");
    expect(p.partsVocab).toBe(true);
    expect(p.vin).toBeNull();
  });
  it("treats 'عندكم فلتر زيت؟' as a part request", () => {
    expect(parseMessage("عندكم فلتر زيت؟").partRequest).toBe("فلتر زيت");
  });
  it("handles part first, VIN second in one message", () => {
    const p = parseMessage("فلتر زيت TESTLC20220000001");
    expect(p.vin).toBe("TESTLC20220000001");
    expect(p.partRequest).toBe("فلتر زيت");
  });
  it("drops the Gulf conjunction و before a part word", () => {
    expect(parseMessage("وفلتر هواء").partRequest).toBe("فلتر هواء");
    expect(parseMessage("و فلتر هواء").partRequest).toBe("فلتر هواء");
  });
  it("recognises greetings only", () => {
    const p = parseMessage("السلام عليكم ورحمة الله");
    expect(p.isGreeting).toBe(true);
    expect(p.partRequest).toBeNull();
  });
  it("recognises yes / no / thanks / staff / restart", () => {
    expect(parseMessage("نعم").isYes).toBe(true);
    expect(parseMessage("ايوه").isYes).toBe(true);
    expect(parseMessage("لا").isNo).toBe(true);
    expect(parseMessage("yes").isYes).toBe(true);
    expect(parseMessage("شكرا").isThanks).toBe(true);
    expect(parseMessage("ابي اكلم موظف").wantsStaff).toBe(true);
    expect(parseMessage("I want to talk to a person").wantsStaff).toBe(true);
    expect(parseMessage("ابدأ من جديد").wantsRestart).toBe(true);
  });
  it("flags off-topic requests but not parts requests", () => {
    expect(parseMessage("اكتب لي قصيدة عن الصحراء").offTopic).toBe(true);
    expect(parseMessage("what is the weather today").offTopic).toBe(true);
    expect(parseMessage("who are you").offTopic).toBe(true);
    expect(parseMessage("وش رايك في الاسهم اليوم").offTopic).toBe(true);
    expect(parseMessage("هذا الشاصي").partRequest).toBeNull();
    expect(parseMessage("ابغى فلتر زيت").offTopic).toBe(false);
    expect(parseMessage("brake pads front").offTopic).toBe(false);
  });
  it("cleanPartRequest drops the current vehicle's model", () => {
    expect(cleanPartRequest("فلتر زيت للاند كروزر", { modelHints: ["لاند كروزر"] })).toBe("فلتر زيت");
  });
});

describe("parseVariantChoice", () => {
  const mk = (engine: string): VehicleRef => ({
    vehicleId: `v_${engine}`, make: "Toyota", modelAr: "هايلكس", modelEn: "Hilux", year: 2020, trim: "GLX",
    engine, transmission: null, market: null, productionDate: null, differsBy: "engine", acknowledged: false,
  });
  const cands = [mk("2.7L petrol"), mk("4.0L V6 petrol")];
  it("accepts a number, in Latin or Arabic-Indic digits", () => {
    expect(parseVariantChoice("2", cands)).toBe(1);
    expect(parseVariantChoice("١", cands)).toBe(0);
    expect(parseVariantChoice("رقم 2", cands)).toBe(1);
    expect(parseVariantChoice("2)", cands)).toBe(1);
  });
  it("rejects out-of-range numbers", () => {
    expect(parseVariantChoice("3", cands)).toBeNull();
    expect(parseVariantChoice("0", cands)).toBeNull();
  });
  it("accepts an ordinal word", () => {
    expect(parseVariantChoice("الثاني", cands)).toBe(1);
    expect(parseVariantChoice("first", cands)).toBe(0);
  });
  it("accepts the option text", () => {
    expect(parseVariantChoice("4.0", cands)).toBe(1);
    expect(parseVariantChoice("the 2.7L one", cands)).toBe(0);
  });
  it("returns null when it is unclear (never guesses)", () => {
    expect(parseVariantChoice("فلتر زيت", cands)).toBeNull();
    expect(parseVariantChoice("petrol", cands)).toBeNull(); // in both options
  });
});
