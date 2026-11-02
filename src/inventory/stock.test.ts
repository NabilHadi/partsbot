import { describe, expect, it } from "vitest";
import { normalizePartNumber, splitOem } from "./normalize.js";
import {
  buildPartStock,
  createStockLookup,
  envAllowsSynthetic,
  InMemoryStockSource,
  MAX_VARIANTS,
  syntheticAllowed,
  type StockRow,
} from "./stock.js";

const AT = new Date("2026-11-02T09:00:00+03:00");
function r(raw: string, qty: number | null, extra: Partial<StockRow & { shopId: string }> = {}): StockRow & { shopId: string } {
  const { oemBase, suffix } = splitOem(raw);
  return {
    shopId: "shop_1",
    partNumberRaw: raw,
    partNumberNormalized: normalizePartNumber(raw),
    oemBase,
    variantSuffix: suffix,
    qty,
    priceSar: qty === null ? null : 100,
    vatIncluded: true,
    isSynthetic: false,
    active: true,
    importedAt: AT,
    ...extra,
  };
}

describe("buildPartStock: exact number first, then oem_base variants", () => {
  it("exact match plus sorted variants (in stock first, then origin, brand, unknown)", () => {
    const rows = [r("04465-06090", 2), r("04465-06090-E", 5), r("04465-06090-J", 0), r("04465-06090-CH", 3), r("17801-0H030-DENSO", 9), r("04465-06090-KYB", 1)];
    const ps = buildPartStock("04465-06090", rows, false);
    expect(ps?.exact).toMatchObject({ suffix: null, qty: 2 });
    expect(ps?.variants.map((v) => v.suffix)).toEqual(["CH", "KYB", "E", "J"]);
    expect(ps?.importedAt).toEqual(AT);
    expect(ps?.synthetic).toBe(false);
  });

  it("variants only when the exact number is not stocked", () => {
    const ps = buildPartStock("04465-06090", [r("04465-06090-J", 4)], false);
    expect(ps?.exact).toBeNull();
    expect(ps?.variants[0]).toMatchObject({ suffix: "J", qty: 4, suffixInfo: { kind: "origin", labelAr: "ياباني" } });
  });

  it("merges rows that normalize the same (qty summed, price from an in-stock row)", () => {
    const ps = buildPartStock("04111-25091", [r("04111-25091", 0, { priceSar: 50 }), r("04111-25091.", 3, { priceSar: 70 })], false);
    expect(ps?.exact).toMatchObject({ qty: 3, priceSar: 70 });
  });

  it("caps variants and ignores inactive rows", () => {
    const rows = ["A", "B", "C", "D", "E", "F"].map((s) => r(`04465-06090-${s}`, 1));
    expect(buildPartStock("04465-06090", rows, false)?.variants).toHaveLength(MAX_VARIANTS);
    expect(buildPartStock("04465-06090", [r("04465-06090", 3, { active: false })], false)).toBeNull();
  });

  it("no rows -> null; a non-OEM number gets exact only", () => {
    expect(buildPartStock("90915-YZZE1", [], false)).toBeNull();
    expect(buildPartStock("X1234", [r("X1234", 1)], false)?.exact?.qty).toBe(1);
  });

  it("freshness = newest contributing import", () => {
    const older = new Date("2026-10-01T09:00:00+03:00");
    const ps = buildPartStock("04465-06090", [r("04465-06090", 1, { importedAt: older }), r("04465-06090-J", 1)], false);
    expect(ps?.importedAt).toEqual(AT);
  });
});

describe("synthetic guard", () => {
  const syn = [r("04465-06090", 7, { isSynthetic: true }), r("04465-06090-J", 3, { isSynthetic: true })];

  it("synthetic rows count as missing unless allowed", () => {
    expect(buildPartStock("04465-06090", syn, false)).toBeNull();
    expect(buildPartStock("04465-06090", syn, true)?.synthetic).toBe(true);
  });

  it("policy: only a test shop that opted in (config or env)", () => {
    expect(syntheticAllowed({ testShop: false, allowSyntheticStock: true, envAllowSynthetic: true })).toBe(false);
    expect(syntheticAllowed({ testShop: true, allowSyntheticStock: false, envAllowSynthetic: false })).toBe(false);
    expect(syntheticAllowed({ testShop: true, allowSyntheticStock: true, envAllowSynthetic: false })).toBe(true);
    expect(syntheticAllowed({ testShop: true, allowSyntheticStock: false, envAllowSynthetic: true })).toBe(true);
  });

  it("env flag must be exactly 'true'", () => {
    expect(envAllowsSynthetic({ ALLOW_SYNTHETIC_STOCK: "true" })).toBe(true);
    expect(envAllowsSynthetic({ ALLOW_SYNTHETIC_STOCK: "1" })).toBe(false);
    expect(envAllowsSynthetic({})).toBe(false);
  });

  it("lookup over a source: other shops' rows are invisible, synthetic filtered", async () => {
    const src = new InMemoryStockSource([...syn, r("90915-YZZE1", 2, { shopId: "shop_2" }), r("17801-0H030", 4)]);
    const hidden = await createStockLookup(src, "shop_1", false)(["04465-06090", "90915-YZZE1", "17801-0H030"]);
    expect([...hidden.keys()]).toEqual(["17801-0H030"]);
    const shown = await createStockLookup(src, "shop_1", true)(["04465-06090"]);
    expect(shown.get("04465-06090")?.exact?.qty).toBe(7);
  });

  it("asks the source for normalized numbers and bases", async () => {
    const seen: unknown[] = [];
    const lookup = createStockLookup({ find: async (...a) => (seen.push(a), []) }, "shop_1", false);
    await lookup(["04465-06090-J", "X1"]);
    expect(seen).toEqual([["shop_1", { normalized: ["0446506090J", "X1"], bases: ["0446506090"] }, false]]);
  });
});
