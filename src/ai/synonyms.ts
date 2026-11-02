/**
 * The synonym list: a DETERMINISTIC layer, owned by the shop admin, that maps Gulf words for parts to the
 * canonical names used for the catalogue search. It runs on every part request, with or without AI:
 *   - rules path: on the cleaned request text,
 *   - AI path: on the customer's raw words FIRST (the table beats the model), then on the model's normalized names.
 * A mapping the model produced that the table does not know becomes a PENDING suggestion for the admin
 * (never applied automatically).
 */
import { cleanPartRequest, normalizeAr, toLatinDigits } from "../bot/intent.js";
import type { AiPart } from "./understand.js";

export interface SynonymEntry {
  term: string;
  canonicalAr: string;
  canonicalEn: string;
}

export interface SynonymHit extends SynonymEntry {
  /** Token span [start, end) in the matched text. */
  start: number;
  end: number;
}

export interface SuggestionInput {
  term: string;
  canonicalAr: string;
  canonicalEn: string;
}

/** One token's matching key: normalized Arabic/lowercase, without the definite article and attached و. */
function tokenKey(tok: string): string {
  let n = normalizeAr(tok);
  if (n.length > 3 && n.startsWith("ال")) n = n.slice(2);
  return n;
}

export function tokenize(text: string): string[] {
  return toLatinDigits(text)
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** The key a term is stored under (synonyms.term_key): token keys joined by single spaces. */
export function synonymKey(term: string): string {
  return tokenize(term).map(tokenKey).join(" ");
}

const MAX_PHRASE = 4;

export class SynonymIndex {
  private readonly byKey = new Map<string, SynonymEntry>();

  constructor(entries: SynonymEntry[]) {
    for (const e of entries) {
      const k = synonymKey(e.term);
      if (k) this.byKey.set(k, e);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  has(term: string): boolean {
    return this.byKey.has(synonymKey(term));
  }

  /** Longest-match-first scan; a token may also carry an attached و ("وقماشات"). */
  match(text: string): SynonymHit[] {
    const toks = tokenize(text);
    const keys = toks.map(tokenKey);
    const hits: SynonymHit[] = [];
    let i = 0;
    while (i < toks.length) {
      let found: SynonymHit | null = null;
      for (let len = Math.min(MAX_PHRASE, toks.length - i); len >= 1 && !found; len--) {
        const span = keys.slice(i, i + len);
        const variants = [span.join(" ")];
        if (span[0]!.length > 3 && span[0]!.startsWith("و")) variants.push([tokenKey(span[0]!.slice(1)), ...span.slice(1)].join(" "));
        for (const v of variants) {
          const e = this.byKey.get(v);
          if (e) {
            found = { ...e, start: i, end: i + len };
            break;
          }
        }
      }
      if (found) {
        hits.push(found);
        i = found.end;
      } else {
        i++;
      }
    }
    return hits;
  }

  /** Replace every matched term with its canonical Arabic name; other words are kept as typed. */
  rewrite(text: string): { text: string; hits: SynonymHit[] } {
    const toks = tokenize(text);
    const hits = this.match(text);
    if (hits.length === 0) return { text: text.trim(), hits };
    const out: string[] = [];
    let i = 0;
    for (const h of hits) {
      out.push(...toks.slice(i, h.start), h.canonicalAr);
      i = h.end;
    }
    out.push(...toks.slice(i));
    // "قماشات فرامل" -> "فحمات فرامل فرامل": drop a word repeated right after the canonical name.
    const words = out.join(" ").split(/\s+/).filter(Boolean);
    const dedup = words.filter((w, j) => j === 0 || tokenKey(w) !== tokenKey(words[j - 1]!));
    return { text: dedup.join(" "), hits };
  }
}

export const POSITION_AR: Record<string, string> = { front: "أمامية", rear: "خلفية", left: "يسار", right: "يمين" };
export const POSITION_EN: Record<string, string> = { front: "front", rear: "rear", left: "left", right: "right" };
const POSITION_WORDS: Record<string, string[]> = {
  front: ["امامي", "اماميه", "امامية", "قدام", "قدامي", "front"],
  rear: ["خلفي", "خلفيه", "خلفية", "خلف", "ورا", "rear", "back"],
  left: ["يسار", "يسرى", "يسار", "left"],
  right: ["يمين", "يمنى", "right"],
};

export interface PartQuery {
  /** Text sent to the catalogue search (`q`, Arabic when known). */
  query: string;
  /** English name of the same part, sent as `q_en` (and as `q` in the one language-swapped retry); null if unknown. */
  queryEn: string | null;
  /** "table" = the synonym list decided the name; "ai" = the model's normalized name (not in the table). */
  source: "table" | "ai" | "raw";
  /** The customer's words are not in the list: proposed mapping for the admin (never applied automatically). */
  suggestion: SuggestionInput | null;
}

const ALL_POSITION_KEYS = new Set(Object.values(POSITION_WORDS).flat().map((w) => tokenKey(w)));
const hasPartNumberish = (s: string) => /[A-Za-z0-9]*\d[A-Za-z0-9-]{4,}/.test(toLatinDigits(s));

/**
 * One AI part -> one catalogue query. Order of authority:
 *   1. the synonym table on the customer's own words,
 *   2. the synonym table on the model's normalized Arabic, then English, name,
 *   3. the model's normalized Arabic name.
 * In cases 2 and 3 the customer's words (minus position words) become a pending suggestion.
 * The position word is added by code from the structured `position` field.
 */
export function queryForAiPart(p: AiPart, index: SynonymIndex | null): PartQuery {
  // Filler ("ابي", "لو سمحت", "تبع المكينة") never reaches the search, also when the table rewrites the rest.
  // Part numbers are left exactly as typed (the cleaner would split "04465-06090").
  const customer = hasPartNumberish(p.customer_words) ? p.customer_words : (cleanPartRequest(p.customer_words) ?? p.customer_words);
  const fromCustomer = index?.rewrite(customer);
  let base: string;
  let en: string | null = null;
  let source: PartQuery["source"];
  let canonical: { ar: string; en: string } | null = null;
  /** English from the table when the hits cover every (non-position) word; otherwise the model's English name. */
  const tableEn = (text: string, hits: SynonymHit[]) => {
    const covered = new Set(hits.flatMap((h) => Array.from({ length: h.end - h.start }, (_, k) => h.start + k)));
    const rest = tokenize(text).filter((w, i) => !covered.has(i) && !ALL_POSITION_KEYS.has(tokenKey(w)));
    return rest.length === 0 ? hits.map((h) => h.canonicalEn).join(" ") : p.normalized_en.trim() || null;
  };
  if (fromCustomer && fromCustomer.hits.length > 0) {
    base = fromCustomer.text;
    en = tableEn(customer, fromCustomer.hits);
    source = "table";
  } else {
    const fromAr = index && p.normalized_ar ? index.rewrite(p.normalized_ar) : null;
    const enHits = index && p.normalized_en ? index.match(p.normalized_en) : [];
    if (fromAr && fromAr.hits.length > 0) {
      base = fromAr.text;
      en = tableEn(p.normalized_ar, fromAr.hits);
      source = "table";
      if (fromAr.hits.length === 1) canonical = { ar: fromAr.hits[0]!.canonicalAr, en: fromAr.hits[0]!.canonicalEn };
    } else if (enHits.length === 1) {
      base = enHits[0]!.canonicalAr;
      en = enHits[0]!.canonicalEn;
      source = "table";
      canonical = { ar: enHits[0]!.canonicalAr, en: enHits[0]!.canonicalEn };
    } else {
      base = p.normalized_ar || p.normalized_en || customer;
      en = p.normalized_en.trim() || null;
      source = p.normalized_ar || p.normalized_en ? "ai" : "raw";
      if (p.normalized_ar) canonical = { ar: p.normalized_ar.trim(), en: p.normalized_en.trim() };
    }
  }
  let suggestion: SuggestionInput | null = null;
  if (index && canonical && !hasPartNumberish(p.customer_words)) {
    const words = tokenize(customer).filter((w) => !ALL_POSITION_KEYS.has(tokenKey(w)));
    const term = words.join(" ");
    const key = synonymKey(term);
    if (words.length >= 1 && words.length <= 4 && key.length >= 2 && key !== synonymKey(canonical.ar) && !index.has(term)) {
      suggestion = { term, canonicalAr: canonical.ar, canonicalEn: canonical.en };
    }
  }
  if (p.position) {
    // Code owns the position wording: dialect words (قدام، ورا) are replaced by the catalogue word.
    const kept = tokenize(base).filter((w) => !ALL_POSITION_KEYS.has(tokenKey(w)));
    base = [...(kept.length ? kept : [base]), POSITION_AR[p.position]].join(" ");
    if (en) {
      const keptEn = tokenize(en).filter((w) => !ALL_POSITION_KEYS.has(tokenKey(w)));
      en = [POSITION_EN[p.position], ...(keptEn.length ? keptEn : [en])].join(" ");
    }
  }
  const query = base.trim();
  const queryEn = en && synonymKey(en) !== synonymKey(query) ? en.trim() : null;
  return { query, queryEn, source, suggestion };
}
