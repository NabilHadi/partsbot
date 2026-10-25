import { describe, expect, it } from "vitest";
import { DEFAULT_SHOP_CONFIG, localTime, parseShopConfig, staffAvailability } from "./shop-config.js";

describe("parseShopConfig", () => {
  it("an empty object is valid and conservative", () => {
    const c = parseShopConfig({});
    expect(c).toEqual(DEFAULT_SHOP_CONFIG);
    expect(c.priceQuotingEnabled).toBe(false);
    expect(c.maxBotMessagesPerDay).toBe(40);
    expect(c.sessionTtlMinutes).toBe(120);
    expect(c.language).toBe("auto");
  });
  it("null/undefined also give the defaults", () => {
    expect(parseShopConfig(null)).toEqual(DEFAULT_SHOP_CONFIG);
    expect(parseShopConfig(undefined)).toEqual(DEFAULT_SHOP_CONFIG);
  });
  it("overrides and validates", () => {
    expect(parseShopConfig({ maxBotMessagesPerDay: 5, shopName: "الأمل" }).maxBotMessagesPerDay).toBe(5);
    expect(() => parseShopConfig({ maxBotMessagesPerDay: 0 })).toThrow();
    expect(() => parseShopConfig({ language: "fr" })).toThrow();
    expect(() => parseShopConfig({ businessHours: { days: { sun: [{ open: "22:00", close: "09:00" }] } } })).toThrow();
  });
  it("accepts partial business hours (missing days = closed)", () => {
    const c = parseShopConfig({ businessHours: { days: { sun: [{ open: "08:00", close: "12:00" }] } } });
    expect(c.businessHours.days.mon).toBeUndefined();
  });
});

describe("localTime (Asia/Riyadh = UTC+3)", () => {
  it("converts across midnight", () => {
    // 2026-10-25 21:30 UTC is Monday 2026-10-26 00:30 in Riyadh.
    const t = localTime(new Date("2026-10-25T21:30:00Z"));
    expect(t).toEqual({ weekday: "mon", minutes: 30, dateKey: "2026-10-26" });
  });
});

describe("staffAvailability", () => {
  const hours = DEFAULT_SHOP_CONFIG.businessHours;
  it("open inside a window, closed outside", () => {
    expect(staffAvailability(new Date("2026-10-25T09:00:00+03:00"), hours)).toEqual({ open: true }); // Sunday
    const late = staffAvailability(new Date("2026-10-25T23:00:00+03:00"), hours);
    expect(late).toEqual({ open: false, next: { dayOffset: 1, weekday: "mon", time: "09:00" } });
  });
  it("Friday morning is closed until 16:00 the same day", () => {
    const fri = staffAvailability(new Date("2026-10-30T10:00:00+03:00"), hours);
    expect(fri).toEqual({ open: false, next: { dayOffset: 0, weekday: "fri", time: "16:00" } });
  });
  it("no hours at all -> closed with no next opening", () => {
    expect(staffAvailability(new Date(), { timezone: "Asia/Riyadh", days: {} })).toEqual({ open: false, next: null });
  });
});
