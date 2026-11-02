import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOP_CONFIG, closedPeriodKey, localTime, maskPhone, normalizeWhatsAppNumber, parseShopConfig, staffAvailability, type BusinessHours,
} from "./shop-config.js";


describe("parseShopConfig", () => {
  it("an empty object is valid and conservative", () => {
    const c = parseShopConfig({});
    expect(c).toEqual(DEFAULT_SHOP_CONFIG);
    expect(c.priceQuotingEnabled).toBe(false);
    expect(c.showPartNumbers).toBe(true);
    expect(c.stockDisplay).toBe("availability");
    expect(c.showAlternatives).toBe(true);
    expect(c.afterHoursMode).toBe("reply_with_note");
    expect(c.language).toBe("ar");
    expect(c.staff).toEqual([]);
    expect(c.testShop).toBe(false);
    expect(c.allowSyntheticStock).toBe(false);
    expect(c.maxBotMessagesPerDay).toBe(40);
    expect(c.sessionTtlMinutes).toBe(120);
  });
  it("null/undefined also give the defaults; the old test-shop config still parses", () => {
    expect(parseShopConfig(null)).toEqual(DEFAULT_SHOP_CONFIG);
    expect(parseShopConfig(undefined)).toEqual(DEFAULT_SHOP_CONFIG);
    expect(parseShopConfig({ testShop: true, allowSyntheticStock: true, priceQuotingEnabled: true }).priceQuotingEnabled).toBe(true);
  });
  it("overrides and validates", () => {
    expect(parseShopConfig({ maxBotMessagesPerDay: 5, shopName: "الأمل" }).maxBotMessagesPerDay).toBe(5);
    expect(parseShopConfig({ stockDisplay: "quantity", showPartNumbers: false, language: "auto" })).toMatchObject({ stockDisplay: "quantity", showPartNumbers: false, language: "auto" });
  });
  it.each([
    ["daily cap 0", { maxBotMessagesPerDay: 0 }],
    ["unknown language", { language: "fr" }],
    ["unknown stock mode", { stockDisplay: "full" }],
    ["unknown after-hours mode", { afterHoursMode: "silent" }],
    ["typo in a key", { showPartNumber: false }],
    ["string instead of boolean", { showAlternatives: "no" }],
    ["open == close", { businessHours: { days: { sun: [{ open: "09:00", close: "09:00" }] } } }],
    ["bad time", { businessHours: { days: { sun: [{ open: "9am", close: "12:00" }] } } }],
    ["overlapping split shift", { businessHours: { days: { fri: [{ open: "08:00", close: "12:00" }, { open: "11:00", close: "23:00" }] } } }],
    ["overnight window runs into the next day's shift", { businessHours: { days: { thu: [{ open: "16:00", close: "09:00" }], fri: [{ open: "08:00", close: "12:00" }] } } }],
    ["Saturday overnight runs into Sunday", { businessHours: { days: { sat: [{ open: "20:00", close: "10:00" }], sun: [{ open: "09:00", close: "12:00" }] } } }],
    ["five windows in a day", { businessHours: { days: { sun: ["01", "03", "05", "07", "09"].map((h) => ({ open: `${h}:00`, close: `${h}:30` })) } } }],
    ["staff phone not normalized", { staff: [{ name: "أبو فهد", phone: "0501234567" }] }],
    ["staff with the old encrypted shape", { staff: [{ name: "أبو فهد", phoneEnc: "v1.a.b.c", phoneHint: "67" }] }],
    ["staff without a name", { staff: [{ name: " ", phone: "+966501234567" }] }],
  ])("rejects invalid config: %s", (_label, cfg) => {
    expect(() => parseShopConfig(cfg)).toThrow();
  });
  it("accepts split shifts, adjacent windows, overnight windows, 24:00 and staff", () => {
    const c = parseShopConfig({
      businessHours: { days: { fri: [{ open: "08:00", close: "12:00" }, { open: "16:00", close: "23:00" }], thu: [{ open: "16:00", close: "02:00" }], sun: [{ open: "08:00", close: "12:00" }, { open: "12:00", close: "24:00" }] } },
      staff: [{ name: "أبو فهد", phone: "+966501234567" }],
    });
    expect(c.businessHours.days.mon).toBeUndefined();
    expect(c.staff[0]?.notify).toBe(true);
  });
});

describe("maskPhone", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskPhone("+966501234567")).toBe("•••••••••4567");
    expect(maskPhone("+966501234567")).not.toContain("50123");
  });
});

describe("normalizeWhatsAppNumber", () => {
  it.each([
    ["0501234567", "+966501234567"],
    ["050 123 4567", "+966501234567"],
    ["966501234567", "+966501234567"],
    ["00966501234567", "+966501234567"],
    ["+966 50-123-4567", "+966501234567"],
    ["+971501234567", "+971501234567"],
  ])("%s -> %s", (input, out) => expect(normalizeWhatsAppNumber(input)).toBe(out));
  it.each(["0112345678", "+966112345678", "12345", "abc", ""])("rejects %s", (input) => expect(normalizeWhatsAppNumber(input)).toBeNull());
});

describe("localTime (Asia/Riyadh = UTC+3)", () => {
  it("converts across midnight", () => {
    // 2026-10-25 21:30 UTC is Monday 2026-10-26 00:30 in Riyadh.
    const t = localTime(new Date("2026-10-25T21:30:00Z"));
    expect(t).toEqual({ weekday: "mon", minutes: 30, dateKey: "2026-10-26" });
  });
});

const at = (iso: string) => new Date(`${iso}+03:00`);

describe("staffAvailability", () => {
  const hours = DEFAULT_SHOP_CONFIG.businessHours;
  it("open inside a window, closed outside", () => {
    expect(staffAvailability(at("2026-10-25T09:00:00"), hours)).toEqual({ open: true }); // Sunday
    const late = staffAvailability(at("2026-10-25T23:00:00"), hours);
    expect(late).toEqual({ open: false, next: { dayOffset: 1, weekday: "mon", time: "09:00" } });
  });
  it("Friday morning is closed until 16:00 the same day", () => {
    const fri = staffAvailability(at("2026-10-30T10:00:00"), hours);
    expect(fri).toEqual({ open: false, next: { dayOffset: 0, weekday: "fri", time: "16:00" } });
  });
  it("no hours at all -> closed with no next opening, and no after-hours period", () => {
    expect(staffAvailability(new Date(), { timezone: "Asia/Riyadh", days: {} })).toEqual({ open: false, next: null });
    expect(closedPeriodKey(new Date(), { timezone: "Asia/Riyadh", days: {} })).toBeNull();
  });

  // Friday split shift 08-12 and 16-23; Thursday runs past midnight to 01:00; Saturday 08-12 / 16-24.
  const split: BusinessHours = parseShopConfig({
    businessHours: {
      days: {
        thu: [{ open: "16:00", close: "01:00" }],
        fri: [{ open: "08:00", close: "12:00" }, { open: "16:00", close: "23:00" }],
        sat: [{ open: "08:00", close: "12:00" }, { open: "16:00", close: "24:00" }],
      },
    },
  }).businessHours;
  it.each([
    ["Thu 23:59 (overnight window)", "2026-10-29T23:59:00", { open: true }],
    ["Fri 00:30 (Thursday's window past midnight)", "2026-10-30T00:30:00", { open: true }],
    ["Fri 01:00 (overnight window just closed)", "2026-10-30T01:00:00", { open: false, next: { dayOffset: 0, weekday: "fri", time: "08:00" } }],
    ["Fri 11:59 (morning shift)", "2026-10-30T11:59:00", { open: true }],
    ["Fri 12:00 (break between shifts)", "2026-10-30T12:00:00", { open: false, next: { dayOffset: 0, weekday: "fri", time: "16:00" } }],
    ["Fri 22:59 (evening shift)", "2026-10-30T22:59:00", { open: true }],
    ["Fri 23:00 (closed until Saturday)", "2026-10-30T23:00:00", { open: false, next: { dayOffset: 1, weekday: "sat", time: "08:00" } }],
    ["Sat 23:59 (24:00 close)", "2026-10-31T23:59:00", { open: true }],
    ["Sun 00:00 (closed until Thursday)", "2026-11-01T00:00:00", { open: false, next: { dayOffset: 4, weekday: "thu", time: "16:00" } }],
  ])("%s", (_label, iso, expected) => {
    expect(staffAvailability(at(iso), split)).toEqual(expected);
  });
  it("Saturday night window wraps into Sunday morning", () => {
    const h = parseShopConfig({ businessHours: { days: { sat: [{ open: "20:00", close: "02:00" }] } } }).businessHours;
    expect(staffAvailability(at("2026-11-01T01:30:00"), h)).toEqual({ open: true }); // Sunday 01:30
    expect(staffAvailability(at("2026-11-01T02:00:00"), h)).toEqual({ open: false, next: { dayOffset: 6, weekday: "sat", time: "20:00" } });
  });
  it("closedPeriodKey names the next opening, the same for the whole closed period", () => {
    expect(closedPeriodKey(at("2026-10-30T12:00:00"), split)).toBe("2026-10-30 16:00");
    expect(closedPeriodKey(at("2026-10-30T15:59:00"), split)).toBe("2026-10-30 16:00");
    expect(closedPeriodKey(at("2026-10-30T23:00:00"), split)).toBe("2026-10-31 08:00");
    expect(closedPeriodKey(at("2026-10-31T07:59:00"), split)).toBe("2026-10-31 08:00");
    expect(closedPeriodKey(at("2026-10-30T11:00:00"), split)).toBeNull();
  });
});
