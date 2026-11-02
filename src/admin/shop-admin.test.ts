import { describe, expect, it } from "vitest";
import { addStaff, AdminInputError, applySet, applyUnset, parseAssignments, parseWindows, removeStaff, renderConfig } from "./shop-admin.js";

const SHOP = "5dcb8a94-2ef8-4469-a742-1bccdc4259f9";

describe("shop admin", () => {
  it("parses key=value with types and hours specs", () => {
    expect(parseAssignments(["showPartNumbers=false", "maxPartsPerReply=2", "stockDisplay=quantity", "hours.fri=8:00-12:00,16:00-23:00", "hours.sat=closed"])).toEqual([
      { key: "showPartNumbers", value: false },
      { key: "maxPartsPerReply", value: 2 },
      { key: "stockDisplay", value: "quantity" },
      { key: "hours.fri", value: [{ open: "08:00", close: "12:00" }, { open: "16:00", close: "23:00" }] },
      { key: "hours.sat", value: [] },
    ]);
    expect(() => parseWindows("9-17")).toThrow(AdminInputError);
    expect(() => parseAssignments(["oops"])).toThrow(AdminInputError);
  });

  it("stores only explicit keys and validates the result", () => {
    const { raw, config } = applySet({ testShop: true }, parseAssignments(["showPartNumbers=false", "stockDisplay=hidden"]));
    expect(raw).toEqual({ testShop: true, showPartNumbers: false, stockDisplay: "hidden" });
    expect(config.showAlternatives).toBe(true);
  });

  it("rejects invalid values, unknown keys and direct staff edits without changing anything", () => {
    const raw = { testShop: true };
    expect(() => applySet(raw, parseAssignments(["stockDisplay=exact"]))).toThrow(/stockDisplay/);
    expect(() => applySet(raw, parseAssignments(["showPrices=true"]))).toThrow(/unknown setting/);
    expect(() => applySet(raw, parseAssignments(['staff=[{"name":"x","phone":"0500000000"}]']))).toThrow(/staff-add/);
    expect(() => applySet(raw, parseAssignments(["hours.fri=08:00-12:00,11:00-14:00"]))).toThrow(/invalid config/);
    expect(() => applySet(raw, parseAssignments(["hours.xyz=closed"]))).toThrow(/unknown day/);
    expect(raw).toEqual({ testShop: true });
  });

  it("editing one day starts from the default week; unset goes back to defaults", () => {
    const { raw, config } = applySet({}, parseAssignments(["hours.fri=08:00-12:00,16:00-23:00"]));
    expect(config.businessHours.days.fri).toHaveLength(2);
    expect(config.businessHours.days.sat).toEqual([{ open: "09:00", close: "22:00" }]);
    expect(applyUnset(raw, ["hours"]).raw).toEqual({});
    expect(applyUnset({ showPartNumbers: false }, ["showPartNumbers"]).raw).toEqual({});
  });

  it("staff: phone stored as normalized E.164, shown masked (last 4 digits only)", () => {
    const { raw, config } = addStaff({}, { name: "أبو فهد", phone: "055 123 4567" });
    expect(raw).toEqual({ staff: [{ name: "أبو فهد", phone: "+966551234567", notify: true }] });
    const s = config.staff[0]!;
    expect(s.phone).toBe("+966551234567");
    const shown = renderConfig(raw, config).join("\n");
    expect(shown).toContain("أبو فهد");
    expect(shown).toContain("•4567");
    expect(shown).not.toContain("55123");
    expect(shown).not.toContain("+966551234567");
    expect(() => addStaff(raw, { name: "أبو فهد", phone: "0559999999" })).toThrow(/already exists/);
    expect(() => addStaff(raw, { name: "x", phone: "0112345678" })).toThrow(/not a valid/);
    expect(addStaff(raw, { name: "y", phone: "0559999999", notify: false }).config.staff[1]?.notify).toBe(false);
    expect(removeStaff(raw, "أبو فهد").config.staff).toEqual([]);
  });

  it("validation errors never echo a phone number", () => {
    try {
      applySet({ staff: [{ name: "a", phone: "0551234567" }] }, parseAssignments(["showPartNumbers=false"]));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/staff\.0\.phone/);
      expect((e as Error).message).not.toContain("0551234567");
    }
  });
});
