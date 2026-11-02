/**
 * SYNTHETIC stock (Nabil 2026-11-02: "for the price and quantity fill it randomly"). The Medrar export has no
 * quantity or price columns, so for testing we generate them. Deterministic per (seed, part number): the same
 * seed always gives the same numbers for the same row, regardless of row order. Every row produced this way is
 * stored with is_synthetic = true and must never reach a real customer (see stock.ts guard).
 */

/** FNV-1a 32-bit. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SYNTHETIC = {
  zeroQtyShare: 0.25,
  maxQty: 20,
  minPriceSar: 15,
  maxPriceSar: 1500,
} as const;

export interface SyntheticStock {
  qty: number;
  /** SAR, VAT-inclusive. */
  priceSar: number;
}

export function syntheticStock(seed: number, partNumberRaw: string): SyntheticStock {
  const rnd = mulberry32(hash32(`${seed}|${partNumberRaw}`));
  const qty = rnd() < SYNTHETIC.zeroQtyShare ? 0 : 1 + Math.floor(rnd() * SYNTHETIC.maxQty);
  // log-uniform: many cheap parts, few expensive ones
  const { minPriceSar: lo, maxPriceSar: hi } = SYNTHETIC;
  const raw = Math.exp(Math.log(lo) + rnd() * (Math.log(hi) - Math.log(lo)));
  const priceSar = raw < 100 ? Math.round(raw) : Math.min(hi, Math.round(raw / 5) * 5);
  return { qty, priceSar };
}
