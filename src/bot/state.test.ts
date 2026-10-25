import { describe, expect, it } from "vitest";
import { DEFAULT_SHOP_CONFIG } from "./shop-config.js";
import { isExpired, newState, parseState, resetState } from "./state.js";

const t0 = new Date("2026-10-25T09:00:00+03:00");
const plus = (min: number) => new Date(t0.getTime() + min * 60_000);

describe("conversation state", () => {
  it("round-trips through JSON", () => {
    const s = newState(t0);
    s.step = "awaiting_vin";
    s.pendingPart = "فلتر زيت";
    expect(parseState(JSON.parse(JSON.stringify(s)), t0)).toEqual(s);
  });
  it("unreadable JSON becomes a fresh state instead of crashing", () => {
    expect(parseState({ v: 99, nonsense: true }, t0).step).toBe("idle");
    expect(parseState(null, t0).step).toBe("idle");
  });
  it("expires after the session TTL (120 min default)", () => {
    const s = newState(t0);
    expect(isExpired(s, plus(119), DEFAULT_SHOP_CONFIG)).toBe(false);
    expect(isExpired(s, plus(121), DEFAULT_SHOP_CONFIG)).toBe(true);
  });
  it("a handoff state lasts for the (longer) silence window", () => {
    const s = newState(t0);
    s.step = "handoff";
    expect(isExpired(s, plus(121), DEFAULT_SHOP_CONFIG)).toBe(false);
    expect(isExpired(s, plus(721), DEFAULT_SHOP_CONFIG)).toBe(true);
  });
  it("reset keeps language, the cap marker and the replay id, and drops everything else", () => {
    const s = newState(t0, "en");
    s.vin = "TESTLC20220000001";
    s.pendingPart = "x";
    s.capNotifiedDay = "2026-10-25";
    s.lastMessageId = "wamid.1";
    const r = resetState(s, plus(500));
    expect(r).toMatchObject({ step: "idle", lang: "en", vin: null, pendingPart: null, capNotifiedDay: "2026-10-25", lastMessageId: "wamid.1" });
  });
});
