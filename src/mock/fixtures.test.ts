import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PARTS, VIN_FIXTURES, FAKE_VINS } from "./fixtures.js";
import { STOCK_TEST_PARTS, STOCK_TEST_PART_NUMBERS, STOCK_TEST_VEHICLE_ID, STOCK_TEST_VIN, stockTestCamry } from "./stock-test-fixtures.js";

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

describe("stock test fixture (real numbers on a fake vehicle) stays contained", () => {
  it("uses a TEST VIN and a test vehicle id", () => {
    expect(STOCK_TEST_VIN).toMatch(/^TEST[A-HJ-NPR-Z0-9]{13}$/);
    expect(stockTestCamry.vin).toBe(STOCK_TEST_VIN);
    expect(STOCK_TEST_VEHICLE_ID).toMatch(/test/);
  });

  it("real numbers are exactly the listed ones and fit only the test vehicle", () => {
    expect(STOCK_TEST_PARTS.map((p) => p.part_number)).toEqual([...STOCK_TEST_PART_NUMBERS]);
    for (const p of STOCK_TEST_PARTS) expect(Object.keys(p.fitment)).toEqual([STOCK_TEST_VEHICLE_ID]);
    // and the placeholder catalogue never fits the test vehicle
    for (const p of PARTS) expect(p.fitment[STOCK_TEST_VEHICLE_ID]).toBeUndefined();
  });
});

describe("stock test fixture is not on any real-data path", () => {
  it("only the mock and tests import it", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith(path.join(src, "mock"))) {
          if (readFileSync(f, "utf8").includes("stock-test-fixtures")) offenders.push(path.relative(src, f));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
