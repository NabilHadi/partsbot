import { describe, expect, it } from "vitest";
import { healthState } from "./attempt-repo.js";

const base = { calls: 10, ok: 10, answeredByRetry: 0, lastCallAt: new Date(), lastFinalOk: true, lastErrorAt: null, lastErrorReason: null };

describe("healthState", () => {
  it("rates recent calls", () => {
    expect(healthState({ ...base, calls: 0, ok: 0, lastFinalOk: null }, false)).toBe("NO_CALLS");
    expect(healthState(base, false)).toBe("OK");
    expect(healthState({ ...base, ok: 8 }, false)).toBe("DEGRADED");
    expect(healthState({ ...base, lastFinalOk: false }, false)).toBe("DEGRADED");
    expect(healthState({ ...base, ok: 4 }, false)).toBe("FAILING");
    expect(healthState(base, true)).toBe("FAILING");
  });
});
