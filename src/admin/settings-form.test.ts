import { describe, expect, it } from "vitest";
import { shopConfigSchema } from "../bot/shop-config.js";
import { SETTINGS_FIELDS, SPECIAL_KEYS, applySettingsForm, diffConfig, formValuesFromRaw } from "./settings-form.js";

const empty = () => Object.fromEntries(SETTINGS_FIELDS.map((f) => [f.key, ""]));

describe("admin settings form", () => {
  it("covers every shop-config setting", () => {
    const covered = new Set<string>([...SETTINGS_FIELDS.map((f) => f.key), ...SPECIAL_KEYS]);
    expect([...Object.keys(shopConfigSchema.shape)].sort()).toEqual([...covered].sort());
  });

  it("stores only chosen keys, keeps staff, and validates with the shared schema", () => {
    const current = { testShop: true, staff: [{ name: "a", phone: "+966551234567", notify: true }] };
    const r = applySettingsForm(current, { ...empty(), testShop: "true", showPartNumbers: "false", stockDisplay: "quantity", maxPartsPerReply: "2", hoursMode: "default" });
    expect(r.errors).toEqual({});
    expect(r.raw).toEqual({ ...current, showPartNumbers: false, stockDisplay: "quantity", maxPartsPerReply: 2 });
    expect(r.config?.showAlternatives).toBe(true);
  });

  it("returns inline errors and no config for invalid values", () => {
    const r = applySettingsForm({}, { ...empty(), maxPartsPerReply: "99", stockDisplay: "exact", stockStaleDays: "abc", hoursMode: "custom", "hours.fri": "08:00-12:00,11:00-14:00", "hours.sat": "9-5" });
    expect(r.config).toBeUndefined();
    expect(Object.keys(r.errors).sort()).toEqual(["hours.sat", "stockDisplay", "stockStaleDays"]);
    const r2 = applySettingsForm({}, { ...empty(), maxPartsPerReply: "99", hoursMode: "custom", "hours.fri": "08:00-12:00,11:00-14:00" });
    expect(r2.config).toBeUndefined();
    expect(r2.errors.maxPartsPerReply).toBeTruthy();
    expect(r2.errors.hoursMode ?? r2.errors["hours.fri"]).toBeTruthy();
  });

  it("custom hours round-trip; default removes them", () => {
    const form = { ...empty(), hoursMode: "custom", "hours.sun": "08:00-12:00,16:00-23:00", "hours.mon": "closed", "hours.tue": "09:00-22:00", "hours.wed": "09:00-22:00", "hours.thu": "16:00-02:00", "hours.fri": "closed", "hours.sat": "09:00-22:00" };
    const r = applySettingsForm({}, form);
    expect(r.errors).toEqual({});
    expect(r.config?.businessHours.days.sun).toHaveLength(2);
    const v = formValuesFromRaw(r.raw, r.config!);
    expect(v.hoursMode).toBe("custom");
    expect(v["hours.sun"]).toBe("08:00-12:00,16:00-23:00");
    expect(applySettingsForm(r.raw, { ...empty(), hoursMode: "default" }).raw.businessHours).toBeUndefined();
  });

  it("diff lists changed keys only, never staff", () => {
    expect(diffConfig({ a: 1, staff: [1] }, { a: 2, b: true, staff: [2] })).toEqual({ a: { from: 1, to: 2 }, b: { from: "(default)", to: true } });
  });
});
