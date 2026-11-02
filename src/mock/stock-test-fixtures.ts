// ============================================================================
// TEST FIXTURE: a FAKE vehicle with parts that carry REAL part numbers.
//
// Why: the stock lookup matches OneEPC numbers against a shop's imported list. The mock's placeholder
// numbers (00000-EXAMPLEn) can never match real shop data, so the stock path could not be tried end to end.
// These three numbers are copied from the Medrar sample export (shop 51) where the shop's own item names say
// Camry; they exist there with several origin/brand variants (-J, -CH, -DENSO, ...).
//
// Rules:
//  - The VIN is fake (starts with TEST) and the vehicle id says "test". Nothing here is a real catalogue answer;
//    the "confirmed" fitment is asserted by this fixture, not by OneEPC.
//  - Mock server only (src/mock). Never import this from bot, worker or importer code; fixtures.test.ts checks
//    that these numbers are only fitted to this test vehicle.
// ============================================================================
import type { Fitment, Vehicle } from "../oneepc/types.js";
import type { PartFixture } from "./fixtures.js";

export const STOCK_TEST_VIN = "TESTCM20140000007";
export const STOCK_TEST_VEHICLE_ID = "veh_test_camry_stock";

export const stockTestCamry: Vehicle = {
  vehicle_id: STOCK_TEST_VEHICLE_ID,
  vin: STOCK_TEST_VIN,
  brand: "toyota",
  make: "Toyota",
  model: { ar: "كامري (تجريبي)", en: "Camry (test)" },
  model_code: "TEST-FIXTURE",
  year: 2014,
  engine: "2.5L petrol",
  trim: "GL",
  transmission: "AT",
  market: "GCC",
  production_date: "2014-05",
};

const confirmed: Fitment = { status: "confirmed", conditions: [] };
const BRAKES = { id: "brakes", ar: "الفرامل", en: "Brakes" };
const ENGINE = { id: "engine", ar: "المحرك", en: "Engine" };

/** REAL numbers (from the Medrar sample), FAKE fitment. Test fixture only. */
export const STOCK_TEST_PART_NUMBERS = ["04465-06090", "90915-YZZE1", "17801-0H030"] as const;

export const STOCK_TEST_PARTS: PartFixture[] = [
  {
    part_number: "04465-06090", // TEST FIXTURE (real number, Medrar: Camry front pads; variants -CH -E -J -M K W)
    name: { ar: "فحمات فرامل أمامية", en: "Pad kit, disc brake, front" },
    category: BRAKES,
    diagram_id: null,
    callout: null,
    quantity_per_vehicle: 1,
    keywords: ["فحمات", "فحمات قدام", "تيل", "قدام", "امامي", "امامية", "اماميه", "قماش", "brake", "brakes", "pads", "pad", "front", "فرامل"],
    fitment: { [STOCK_TEST_VEHICLE_ID]: confirmed },
  },
  {
    part_number: "90915-YZZE1", // TEST FIXTURE (real number, Medrar: oil filter Corolla/Camry; variant -CH)
    name: { ar: "فلتر زيت", en: "Filter, oil" },
    category: ENGINE,
    diagram_id: null,
    callout: null,
    quantity_per_vehicle: 1,
    keywords: ["فلتر زيت", "فلتر الزيت", "زيت", "oil", "oil filter", "فلتر مكينة"],
    fitment: { [STOCK_TEST_VEHICLE_ID]: confirmed },
  },
  {
    part_number: "17801-0H030", // TEST FIXTURE (real number, Medrar: air filter Camry 2007-2017; variants -DENSO -J)
    name: { ar: "فلتر هواء", en: "Filter, air cleaner" },
    category: ENGINE,
    diagram_id: null,
    callout: null,
    quantity_per_vehicle: 1,
    keywords: ["فلتر هواء", "فلتر الهواء", "هواء", "هوا", "air", "air filter"],
    fitment: { [STOCK_TEST_VEHICLE_ID]: confirmed },
  },
];
