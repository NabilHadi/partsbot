/**
 * Part-number normalization and row classification for shop stock imports.
 *
 * The rule (shared with lookups, so OneEPC numbers and shop numbers meet in the same form):
 *   NFKC -> Arabic-Indic digits to Latin -> drop Arabic diacritics (tashkeel) -> UPPERCASE -> keep only A-Z and 0-9.
 *   "04465-0K290" -> "044650K290", "04111-25091." -> "0411125091", "*16400-F2050" -> "16400F2050".
 *
 * `oem_base` is the first 10 normalized characters when the raw number starts with a 5+5 OEM-style core
 * (Toyota "04465-0K290", Hyundai/Kia "58101-D3A10"). Whatever follows the core is the shop's variant suffix
 * (origin / brand / quality), e.g. "04465-06090-J" -> base "0446506090", suffix "J".
 * Shop-internal codes (X..., P..., short codes) get no base and only ever match exactly.
 */

const ARABIC_INDIC = /[\u0660-\u0669\u06F0-\u06F9]/g;
/** Arabic harakat, tanween, shadda, sukun, superscript alef, tatweel. */
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;

export function toLatinDigits(s: string): string {
  return s.replace(ARABIC_INDIC, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/** The single normalization rule for part numbers (shop data AND OneEPC results). */
export function normalizePartNumber(raw: string): string {
  return toLatinDigits(raw.normalize("NFKC"))
    .replace(ARABIC_DIACRITICS, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Cleaned display form of a raw number: trimmed, diacritics and stray leading/trailing punctuation removed. */
export function cleanRawPartNumber(raw: string): string {
  return toLatinDigits(raw.normalize("NFKC"))
    .replace(ARABIC_DIACRITICS, "")
    .trim()
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .toUpperCase();
}

export interface OemSplit {
  /** 10 normalized chars, or null for non-OEM-style codes. */
  oemBase: string | null;
  /** Variant suffix after the core, dashes kept between tokens ("A0-J"), or null. */
  suffix: string | null;
}

// 5 digits, optional separator, 5 alphanumerics, then (optionally) a suffix.
const OEM_CORE = /^(\d{5})[-\s]?([A-Z0-9]{5})(?:[-\s.]*([A-Z0-9][A-Z0-9-]*?))?[-.\s]*$/;

export function splitOem(raw: string): OemSplit {
  const s = cleanRawPartNumber(raw);
  const m = OEM_CORE.exec(s);
  if (!m) return { oemBase: null, suffix: null };
  const suffix = m[3] ? m[3].replace(/-+/g, "-").replace(/^-|-$/g, "") : null;
  return { oemBase: `${m[1]}${m[2]}`, suffix: suffix || null };
}

// ------------------------------------------------------------------ suffix meaning

/**
 * Suffix tokens. Nabil (2026-11-02): suffixes are origin/quality variants of the base OEM number.
 * Origins get an Arabic label; known maker suffixes show the brand name; anything else is shown raw and
 * flagged unconfirmed. A plain number (no suffix) is NOT labelled genuine (اصلي): the data does not say so.
 */
export const ORIGIN_SUFFIXES: Record<string, { ar: string; en: string }> = {
  CH: { ar: "صيني", en: "Chinese" },
  J: { ar: "ياباني", en: "Japanese" },
  TH: { ar: "تايلندي", en: "Thai" },
  TW: { ar: "تايواني", en: "Taiwanese" },
};

/** Suffixes that are clearly a parts maker's name (seen in the Medrar sample). DNSO/AISN are typos in the data. */
export const BRAND_SUFFIXES: Record<string, string> = {
  DENSO: "DENSO",
  DNSO: "DENSO",
  KYB: "KYB",
  AISIN: "AISIN",
  AISN: "AISIN",
  KOYO: "KOYO",
  TYC: "TYC",
  "555": "555",
};

export type SuffixKind = "none" | "origin" | "brand" | "unknown";

export interface SuffixInfo {
  kind: SuffixKind;
  /** Arabic / English label for replies; for unknown suffixes the raw suffix. */
  labelAr: string | null;
  labelEn: string | null;
  /** Brand for the `brand` column (origin label or maker name), null when unknown or none. */
  brand: string | null;
  /** True when the meaning is not confirmed (unknown suffix). */
  unconfirmed: boolean;
}

export function describeSuffix(suffix: string | null): SuffixInfo {
  if (!suffix) return { kind: "none", labelAr: null, labelEn: null, brand: null, unconfirmed: false };
  const tokens = suffix.split("-").filter(Boolean);
  // The last token decides ("89341-60060-A0-J": A0 is a variant code, J the origin).
  for (const tok of [...tokens].reverse()) {
    const o = ORIGIN_SUFFIXES[tok];
    if (o) return { kind: "origin", labelAr: o.ar, labelEn: o.en, brand: o.en, unconfirmed: tokens.length > 1 };
    const b = BRAND_SUFFIXES[tok];
    if (b) return { kind: "brand", labelAr: b, labelEn: b, brand: b, unconfirmed: tokens.length > 1 };
  }
  return { kind: "unknown", labelAr: suffix, labelEn: suffix, brand: null, unconfirmed: true };
}

// ------------------------------------------------------------------ alt numbers in names

const ALT_IN_NAME = /(?<![A-Za-z0-9])(\d{5})[-\s]?([A-Za-z0-9]{5})(?![A-Za-z0-9])/g;

/** OEM-style numbers mentioned inside an item name (supersession / alternates). Normalized, de-duplicated, own number excluded. */
export function extractAltNumbers(name: string, ownNormalized: string): string[] {
  const out: string[] = [];
  for (const m of toLatinDigits(name).matchAll(ALT_IN_NAME)) {
    const n = `${m[1]}${m[2]}`.toUpperCase();
    if (!/\d/.test(m[2] ?? "")) continue;
    if (n === ownNormalized || ownNormalized.startsWith(n) || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

// ------------------------------------------------------------------ rejects (placeholders, PII)

/** Saudi mobile: 05XXXXXXXX, 5XXXXXXXX, +9665..., 009665... */
const SAUDI_MOBILE = /^(?:\+?966|00966|0)?5\d{8}$/;
const SAUDI_MOBILE_IN_TEXT = /(?<!\d)(?:\+?966|00966|0)5\d{8}(?!\d)/;

/** An item number that is really a phone number (customer accounts stored as items). Dashed OEM numbers never match. */
export function isPhoneLikeItemNumber(raw: string): boolean {
  const s = toLatinDigits(raw).trim().replace(/[\s()]/g, "");
  return SAUDI_MOBILE.test(s);
}

/** A name that contains a phone number (spaces/dashes between digits tolerated, e.g. "050 123 4567"). */
export function nameContainsPhone(name: string): boolean {
  const compact = toLatinDigits(name).replace(/(?<=\d)[\s-]+(?=\d)/g, "");
  return SAUDI_MOBILE_IN_TEXT.test(compact);
}

export type RejectReason =
  | "empty_part_number"
  | "placeholder_part_number"
  | "spreadsheet_number_mangled"
  | "pii_phone_item_number"
  | "pii_phone_in_name"
  | "duplicate_row";

/** Placeholders: no letters/digits (".", Arabic words such as "حساس"), or all zeros ("00000-00000", "00000-000"). */
export function placeholderReason(raw: string): RejectReason | null {
  if (raw.trim() === "") return "empty_part_number";
  if (/\dE[+-]\d+$/i.test(raw.trim())) return "spreadsheet_number_mangled"; // "1.172-13E+11": Excel turned the number into scientific notation
  const n = normalizePartNumber(raw);
  if (n === "") return "placeholder_part_number";
  if (/^0+$/.test(n)) return "placeholder_part_number";
  return null;
}
