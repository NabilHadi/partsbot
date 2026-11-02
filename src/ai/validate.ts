/**
 * Validator for AI-written replies. The model may only REPHRASE a deterministic draft; anything it adds that
 * could be a fact is rejected and the template draft is sent instead.
 *   - every number must already be in the draft (prices, quantities, years, times, phones),
 *   - no part-number-like token that is not in the draft,
 *   - no URL / e-mail, no phone-like digit run that is not in the draft,
 *   - no price / stock / delivery / warranty / discount words unless the draft has them,
 *   - "[[PARTS]]" (the code-rendered parts block) exactly as often as in the draft,
 *   - "يرجى التأكيد مع الموظف" kept verbatim when the draft has it,
 *   - right language, sane length.
 */
import { CONFIRM_WITH_STAFF_AR, CONFIRM_WITH_STAFF_EN } from "../bot/arabic.js";
import { findPartNumberLikeTokens } from "../bot/guard.js";
import { normalizeAr, toLatinDigits, type Lang } from "../bot/intent.js";

export const PARTS_PLACEHOLDER = "[[PARTS]]";

export type ValidatorFailure =
  | "empty"
  | "placeholder"
  | "new_number"
  | "part_number"
  | "url"
  | "forbidden_topic"
  | "staff_phrase_missing"
  | "wrong_language"
  | "too_long";

const count = (s: string, sub: string) => s.split(sub).length - 1;
const numbers = (s: string) => toLatinDigits(s).match(/\d+(?:[.,]\d+)?/g) ?? [];

/** Topic words the model must not introduce (they would be promises or facts we did not decide). */
const TOPIC_WORDS: { ar: string[]; en: RegExp[] }[] = [
  { ar: ["سعر", "اسعار", "ريال", "تكلف", "بكم"], en: [/\bprices?\b/i, /\bSAR\b/i, /\briyals?\b/i, /\bcosts?\b/i] },
  { ar: ["متوفر", "متوفره", "متوفرة", "مخزون", "موجود عندنا", "نفذ"], en: [/\bin stock\b/i, /\bavailab/i, /\bout of stock\b/i] },
  { ar: ["توصيل", "شحن", "نوصل"], en: [/\bdeliver/i, /\bshipping\b/i] },
  { ar: ["ضمان", "كفاله", "كفالة"], en: [/\bwarrant/i, /\bguarantee/i] },
  { ar: ["خصم", "تخفيض", "عرض خاص", "مجان", "ببلاش"], en: [/\bdiscount/i, /\bfree\b/i, /\boffer\b/i] },
  { ar: ["اصلي", "تجاري", "وكاله", "وكالة"], en: [/\bgenuine\b/i, /\boriginal\b/i, /\bOEM\b/] },
];

function hasTopic(text: string, t: (typeof TOPIC_WORDS)[number]): boolean {
  const n = normalizeAr(text);
  return t.ar.some((w) => n.includes(normalizeAr(w))) || t.en.some((re) => re.test(text));
}

function arabicShare(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  return letters.filter((c) => /[\u0600-\u06FF]/.test(c)).length / letters.length;
}

export interface ValidatorResult {
  ok: boolean;
  failure: ValidatorFailure | null;
}

/** `draft` and `output` are both WITHOUT the parts block (it is "[[PARTS]]" in both). */
export function validateReply(output: string, draft: string, lang: Lang): ValidatorResult {
  const fail = (failure: ValidatorFailure): ValidatorResult => ({ ok: false, failure });
  const out = output.trim();
  if (!out) return fail("empty");
  if (count(out, PARTS_PLACEHOLDER) !== count(draft, PARTS_PLACEHOLDER)) return fail("placeholder");
  const outText = out.split(PARTS_PLACEHOLDER).join(" ");
  const draftText = draft.split(PARTS_PLACEHOLDER).join(" ");

  if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|sa|io|me|ly)\b|@[a-z0-9-]+\.)/i.test(outText) && !/(https?:\/\/|www\.)/i.test(draftText)) return fail("url");
  const allowedPn = new Set(findPartNumberLikeTokens(draftText));
  if (findPartNumberLikeTokens(outText).some((t) => !allowedPn.has(t))) return fail("part_number");
  const allowedNums = new Set(numbers(draftText));
  if (numbers(outText).some((n) => !allowedNums.has(n))) return fail("new_number");
  if (TOPIC_WORDS.some((t) => hasTopic(outText, t) && !hasTopic(draftText, t))) return fail("forbidden_topic");
  for (const phrase of [CONFIRM_WITH_STAFF_AR, CONFIRM_WITH_STAFF_EN]) {
    if (draftText.includes(phrase) && !outText.includes(phrase)) return fail("staff_phrase_missing");
  }
  const share = arabicShare(outText);
  if (lang === "ar" ? share < 0.5 : share > 0.15) return fail("wrong_language");
  if (out.length > Math.max(draft.length * 1.6 + 80, 260) || out.length > 1200) return fail("too_long");
  return { ok: true, failure: null };
}
