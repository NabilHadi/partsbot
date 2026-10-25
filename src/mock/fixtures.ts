// ============================================================================
// FAKE DATA. Everything in this file is invented for development and tests.
// None of these VINs, vehicle ids or part numbers exist in any real catalog,
// and part numbers are deliberately obvious placeholders (00000-EXAMPLEn) so
// nothing here can ever be mistaken for, or quoted as, a real part number.
// Names/translations are illustrative only.
// ============================================================================
import type { Fitment, Localized, SearchAmbiguity, Vehicle, VehicleCandidate } from "../oneepc/types.js";

export const SUPPORTED_BRANDS = ["toyota", "lexus", "hyundai", "genesis", "kia", "daihatsu"] as const;
export const DATA_VERSION = "2026-10-01-mock";

// ---- Vehicles ----

function vehicle(v: Omit<Vehicle, "market"> & { market?: string }): Vehicle {
  return { market: "GCC", ...v };
}

const landCruiser = vehicle({
  vehicle_id: "veh_example_lc",
  vin: "TESTLC20220000001",
  brand: "toyota",
  make: "Toyota",
  model: { ar: "لاند كروزر", en: "Land Cruiser" },
  model_code: "EXAMPLE-CODE",
  year: 2022,
  engine: "3.5L V6 petrol",
  trim: "GXR",
  transmission: "AT",
  production_date: "2022-03",
});

const tucson = vehicle({
  vehicle_id: "veh_example_tucson",
  vin: "TESTHY20210000002",
  brand: "hyundai",
  make: "Hyundai",
  model: { ar: "توسان", en: "Tucson" },
  model_code: "EXAMPLE-CODE",
  year: 2021,
  engine: "2.0L petrol",
  trim: "Comfort",
  transmission: "AT",
  production_date: "2021-06",
});

const sportage = vehicle({
  vehicle_id: "veh_example_sportage",
  vin: "TESTKA20230000006",
  brand: "kia",
  make: "Kia",
  model: { ar: "سبورتاج", en: "Sportage" },
  model_code: "EXAMPLE-CODE",
  year: 2023,
  engine: "2.5L petrol",
  trim: "LX",
  transmission: "AT",
  production_date: "2023-01",
});

/** Ambiguous VIN: two catalog variants differing by engine. Neither is returned as `vehicle`. */
const hiluxCandidates: VehicleCandidate[] = [
  {
    vehicle_id: "veh_example_hilux_a",
    differs_by: "engine",
    brand: "toyota",
    make: "Toyota",
    model: { ar: "هايلكس", en: "Hilux" },
    year: 2020,
    engine: "2.7L petrol",
    trim: "GLX",
  },
  {
    vehicle_id: "veh_example_hilux_b",
    differs_by: "engine",
    brand: "toyota",
    make: "Toyota",
    model: { ar: "هايلكس", en: "Hilux" },
    year: 2020,
    engine: "4.0L V6 petrol",
    trim: "GLX",
  },
];

export const VEHICLES: Vehicle[] = [landCruiser, tucson, sportage];
export const KNOWN_VEHICLE_IDS: ReadonlySet<string> = new Set([
  ...VEHICLES.map((v) => v.vehicle_id),
  ...hiluxCandidates.map((c) => c.vehicle_id),
]);

// ---- VINs (all 17 chars, no I/O/Q; all start with TEST so they are visibly fake) ----

export type VinFixture =
  | { kind: "exact"; vehicle: Vehicle }
  | { kind: "ambiguous"; candidates: VehicleCandidate[] }
  | { kind: "unsupported"; brand: string };

export const VIN_FIXTURES: Record<string, VinFixture> = {
  [landCruiser.vin]: { kind: "exact", vehicle: landCruiser },
  [tucson.vin]: { kind: "exact", vehicle: tucson },
  [sportage.vin]: { kind: "exact", vehicle: sportage },
  TESTAMB2020000003: { kind: "ambiguous", candidates: hiluxCandidates },
  TESTBMW2020000005: { kind: "unsupported", brand: "bmw" },
  // TESTNF00000000004 is intentionally absent: any VIN not listed here is vin_not_found.
};

/** Convenience names for tests/docs. */
export const FAKE_VINS = {
  exactLandCruiser: "TESTLC20220000001",
  exactHyundai: "TESTHY20210000002",
  exactKia: "TESTKA20230000006",
  ambiguous: "TESTAMB2020000003",
  unknown: "TESTNF00000000004",
  unsupportedBrand: "TESTBMW2020000005",
} as const;

// ---- Parts ----

export interface PartFixture {
  part_number: string; // always an obvious placeholder
  name: Localized;
  category: { id: string; ar: string; en: string };
  diagram_id: string | null;
  callout: string | null;
  quantity_per_vehicle: number | null;
  /** Extra words (Arabic dialect, English synonyms) used for matching in addition to the names. */
  keywords: string[];
  /** Which vehicle_ids this part is listed for, and with what fitment. */
  fitment: Record<string, Fitment>;
  /** Returned as the top-level ambiguity when this part comes back with conditional fitment. */
  ambiguity?: SearchAmbiguity;
}

const BRAKES = { id: "brakes", ar: "الفرامل", en: "Brakes" };
const ENGINE = { id: "engine", ar: "المحرك", en: "Engine" };
const confirmed: Fitment = { status: "confirmed", conditions: [] };

export const PARTS: PartFixture[] = [
  {
    part_number: "00000-EXAMPLE1",
    name: { ar: "فحمات فرامل أمامية", en: "Pad kit, disc brake, front" },
    category: BRAKES,
    diagram_id: "dgm_example_brakes",
    callout: "3",
    quantity_per_vehicle: 1,
    keywords: ["فحمات", "فحمات قدام", "تيل", "قدام", "امامي", "brake", "brakes", "pads", "pad", "front", "disc", "فرامل"],
    fitment: { veh_example_lc: { status: "conditional", conditions: ["17 inch brakes"] } },
    ambiguity: {
      is_ambiguous: true,
      reason: "multiple_variants",
      differs_by: "brake_size",
      question_hint: {
        ar: "هل الفرامل الأمامية مقاس 17 أو 18 إنش؟",
        en: "Are the front brakes 17 or 18 inch?",
      },
    },
  },
  {
    part_number: "00000-EXAMPLE2",
    name: { ar: "فحمات فرامل خلفية", en: "Pad kit, disc brake, rear" },
    category: BRAKES,
    diagram_id: "dgm_example_brakes",
    callout: "7",
    quantity_per_vehicle: 1,
    keywords: ["فحمات", "فحمات خلف", "تيل", "خلف", "خلفي", "brake", "brakes", "pads", "pad", "rear", "back", "disc", "فرامل"],
    fitment: { veh_example_lc: confirmed },
  },
  {
    part_number: "00000-EXAMPLE3",
    name: { ar: "فحمات فرامل أمامية", en: "Pad kit, disc brake, front" },
    category: BRAKES,
    diagram_id: "dgm_example_brakes",
    callout: "3",
    quantity_per_vehicle: 1,
    keywords: ["فحمات", "فحمات قدام", "تيل", "قدام", "امامي", "brake", "brakes", "pads", "pad", "front", "disc", "فرامل"],
    fitment: { veh_example_tucson: confirmed },
  },
  {
    part_number: "00000-EXAMPLE4",
    name: { ar: "فلتر زيت", en: "Filter, oil" },
    category: ENGINE,
    diagram_id: "dgm_example_engine",
    callout: "12",
    quantity_per_vehicle: 1,
    keywords: ["فلتر زيت", "فلتر الزيت", "فلتر", "زيت", "oil", "filter", "oil filter", "فلتر مكينة"],
    fitment: {
      veh_example_lc: confirmed,
      veh_example_hilux_a: confirmed,
      veh_example_hilux_b: confirmed,
    },
  },
  {
    part_number: "00000-EXAMPLE5",
    name: { ar: "فلتر زيت", en: "Filter, oil" },
    category: ENGINE,
    diagram_id: null,
    callout: null,
    quantity_per_vehicle: null, // optional in the spec; exercises the null path
    keywords: ["فلتر زيت", "فلتر الزيت", "فلتر", "زيت", "oil", "filter", "oil filter"],
    fitment: { veh_example_tucson: confirmed, veh_example_sportage: confirmed },
  },
  {
    part_number: "00000-EXAMPLE6",
    name: { ar: null, en: "Filter, air cleaner" }, // no Arabic name: bot must show English, not translate
    category: ENGINE,
    diagram_id: null,
    callout: null,
    quantity_per_vehicle: 1,
    keywords: ["فلتر هواء", "فلتر الهواء", "هواء", "air", "filter", "air filter"],
    fitment: { veh_example_lc: confirmed },
  },
];

/** Queries so broad that any result set is ambiguous (reason: broad_query). */
export const BROAD_TERMS: ReadonlySet<string> = new Set(["brake", "brakes", "فرامل", "الفرامل", "filter", "فلتر"]);
export const BROAD_QUERY_AMBIGUITY: SearchAmbiguity = {
  is_ambiguous: true,
  reason: "broad_query",
  differs_by: "part_type",
  question_hint: {
    ar: "أي قطعة تقصد بالضبط؟ مثلاً فحمات أمامية أو خلفية",
    en: "Which part exactly? For example front or rear pads",
  },
};
export const NOT_AMBIGUOUS: SearchAmbiguity = {
  is_ambiguous: false,
  reason: null,
  differs_by: null,
  question_hint: null,
};
