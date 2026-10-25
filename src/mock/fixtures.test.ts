import { describe, expect, it } from "vitest";
import { PARTS, VIN_FIXTURES, FAKE_VINS } from "./fixtures.js";

describe("fixtures stay obviously fake", () => {
  it("part numbers are 00000-EXAMPLEn placeholders", () => {
    for (const p of PARTS) expect(p.part_number).toMatch(/^00000-EXAMPLE\d+$/);
  });

  it("fake VINs are 17 chars, valid charset, and start with TEST", () => {
    for (const vin of Object.values(FAKE_VINS)) {
      expect(vin).toMatch(/^TEST[A-HJ-NPR-Z0-9]{13}$/);
    }
    for (const vin of Object.keys(VIN_FIXTURES)) expect(vin).toMatch(/^TEST[A-HJ-NPR-Z0-9]{13}$/);
  });
});
