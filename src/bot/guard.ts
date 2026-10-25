import { toLatinDigits } from "./intent.js";

/**
 * Runtime guard: a bot reply may only contain part numbers that were handed to us verbatim by OneEPC.
 * The engine builds replies from templates + API data, so this should never fire; it exists so that a
 * future bug (or an LLM added later) cannot put an invented, edited or unconfirmed number in front of a customer.
 *
 * "Part-number-like" is deliberately broad (false alarms just cause a safe handoff):
 *   A. hyphenated alphanumeric groups with a digit and >= 7 characters   04465-0K290, 00000-EXAMPLE1
 *   B. one alphanumeric token of >= 8 characters mixing letters and digits   58101D3A00, a VIN
 *   C. five digits, one space, five alphanumerics   "04465 0K290"
 *   D. a run of >= 8 digits (long numbers: part numbers without letters, phone numbers)
 * Matching is exact: "04465-0K290" is not the same as "044650K290" (we never edit or reformat a number).
 */

const PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9]|[A-Za-z0-9][-–])[A-Za-z0-9]+(?:[-–][A-Za-z0-9]+)+(?![A-Za-z0-9]|[-–][A-Za-z0-9])/g,
  /(?<![A-Za-z0-9]|[A-Za-z0-9][-–])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}(?![A-Za-z0-9]|[-–][A-Za-z0-9])/g,
  /(?<![A-Za-z0-9]|[A-Za-z0-9][-–])\d{5}[ \u00A0][A-Za-z0-9]{5}(?![A-Za-z0-9]|[-–][A-Za-z0-9])/g,
  /(?<![0-9]|[0-9][-–])\d{8,}(?![0-9]|[-–][0-9])/g,
];

export class PartNumberGuardError extends Error {
  constructor(readonly offending: string[]) {
    super(`reply contains ${offending.length} part-number-like token(s) not present in OneEPC results`);
    this.name = "PartNumberGuardError";
  }
}

function suspicious(token: string): boolean {
  const alnum = token.replace(/[^A-Za-z0-9]/g, "");
  if (/^\d{1,4}[-–]\d{1,4}$/.test(token)) return false; // "2020-2022", "17-18"
  const hasDigit = /\d/.test(alnum);
  const hasLetter = /[A-Za-z]/.test(alnum);
  if (!hasDigit) return false;
  return alnum.length >= 7 && (hasLetter || alnum.length >= 9);
}

/** All part-number-like tokens in `text`, in order of appearance, de-duplicated. */
export function findPartNumberLikeTokens(text: string): string[] {
  const t = toLatinDigits(text);
  const found: string[] = [];
  for (const re of PATTERNS) {
    for (const m of t.matchAll(new RegExp(re.source, re.flags))) {
      const tok = m[0];
      if (re === PATTERNS[3] || suspicious(tok)) {
        if (!found.includes(tok)) found.push(tok);
      }
    }
  }
  return found;
}

export interface GuardOptions {
  /** Part numbers (exact strings from OneEPC results) the reply may contain. */
  allowed: Iterable<string>;
  /** Other strings known to be safe, e.g. the shop's phone number or vehicle trim/engine codes from the API. Removed before scanning. */
  ignore?: Iterable<string>;
}

/** Throws PartNumberGuardError if `text` holds a part-number-like token that is not an exact member of `allowed`. */
export function assertOnlyAllowedPartNumbers(text: string, opts: GuardOptions): void {
  let scan = text;
  for (const ig of opts.ignore ?? []) {
    if (ig && ig.length > 0) scan = scan.split(ig).join(" ");
  }
  const allowed = new Set(opts.allowed);
  // Tokens must appear verbatim in what we are sending (not only after digit conversion).
  const bad = findPartNumberLikeTokens(scan).filter((tok) => !allowed.has(tok) || !scan.includes(tok));
  // A known number that was reformatted (spaces, dashes dropped/added, case, Arabic digits) is an edited number.
  const compact = toLatinDigits(scan).toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const pn of allowed) {
    const key = toLatinDigits(pn).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (key.length >= 6 && compact.includes(key) && !scan.includes(pn) && !bad.includes(pn)) bad.push(pn);
  }
  if (bad.length > 0) throw new PartNumberGuardError(bad);
}
