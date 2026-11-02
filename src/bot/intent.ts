import type { VehicleRef } from "./state.js";

/**
 * Deterministic message parsing (no LLM). Everything here is a pure function of the text.
 * Heuristics are intentionally conservative: when unsure, the engine treats text as a part request
 * (OneEPC decides) or asks the customer again, never guesses a part number.
 */

// ---------------------------------------------------------------- normalisation

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Convert Arabic-Indic (٠-٩) and Persian (۰-۹) digits to Latin 0-9. */
export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = ARABIC_INDIC.indexOf(ch);
    return String(i >= 0 ? i : EXT_ARABIC_INDIC.indexOf(ch));
  });
}

/** Lowercase, Latin digits, strip diacritics/tatweel, unify alef/ya/ta-marbuta. For matching only, never shown. */
export function normalizeAr(s: string): string {
  return toLatinDigits(s)
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤ]/g, "و")
    .replace(/[ئ]/g, "ي");
}

const norm = normalizeAr;
const normSet = (words: string[]): Set<string> => new Set(words.map(norm));

// ---------------------------------------------------------------- VIN

/** `frame_number` = a Toyota/Daihatsu frame number ("GGN120-0001234"): not accepted, we ask for the 17-character VIN. */
export type VinProblem = "bad_chars" | "bad_length" | "frame_number";
export interface VinExtraction {
  vin: string | null;
  /** Set when the text looks like a VIN attempt that is not valid (so the bot can ask for it again). */
  problem: VinProblem | null;
  /** The text with the VIN removed (digits converted to Latin). */
  rest: string;
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const GAP_RE = /^[ \u00A0\-\u2010-\u2015]+$/;
/** Frame number shape: model code (1-4 letters, 1-3 digits, optional letter) + serial of 5-8 digits. */
const FRAME_RE = /(?<![A-Z0-9])[A-Z]{1,4}\d{1,3}[A-Z]?[ \u00A0\-\u2010-\u2015]?\d{5,8}(?![A-Z0-9])/;

/**
 * Find a 17-character VIN. Spaces and dashes between groups are ignored, letters are uppercased,
 * Arabic-Indic digits are converted. Letters I, O and Q are never valid in a VIN: a 17-character
 * candidate that contains one is reported as `bad_chars`, not silently "fixed" (O vs 0 is a guess).
 */
export function extractVin(text: string): VinExtraction {
  const t = toLatinDigits(text);
  const tokens = [...t.matchAll(/[A-Za-z0-9]+/g)].map((m) => ({ s: m[0].toUpperCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const hasBoth = (s: string) => /\d/.test(s) && /[A-Z]/.test(s);

  let invalid17: VinProblem | null = null;
  let badLength = false;
  for (const maxTokens of [1, 6]) {
    for (let i = 0; i < tokens.length; i++) {
      let joined = "";
      for (let j = i; j < tokens.length && j - i < maxTokens; j++) {
        const tok = tokens[j]!;
        if (j > i && !GAP_RE.test(t.slice(tokens[j - 1]!.end, tok.start))) break;
        joined += tok.s;
        if (joined.length > 17 && maxTokens === 1) {
          if (joined.length >= 18 && hasBoth(joined)) badLength = true;
          break;
        }
        if (joined.length > 17) break;
        if (joined.length === 17 && hasBoth(joined)) {
          if (VIN_RE.test(joined)) {
            const rest = (t.slice(0, tokens[i]!.start) + " " + t.slice(tok.end)).replace(/\s+/g, " ").trim();
            return { vin: joined, problem: null, rest };
          }
          invalid17 = "bad_chars";
        }
        if (maxTokens === 1 && joined.length >= 11 && joined.length <= 16 && hasBoth(joined)) badLength = true;
      }
    }
  }
  // VINs only for now: a frame number is never decoded, the customer is asked for the VIN instead.
  const frame = invalid17 ? null : FRAME_RE.exec(t.toUpperCase());
  const problem = invalid17 ?? (frame ? "frame_number" : badLength ? "bad_length" : null);
  // The frame number is not part of the part request (same length in upper case, so the index carries over).
  const restText = frame ? t.slice(0, frame.index) + " " + t.slice(frame.index + frame[0].length) : t;
  return { vin: null, problem, rest: restText.replace(/\s+/g, " ").trim() };
}

// ---------------------------------------------------------------- language

export type Lang = "ar" | "en";
/** Script of the message: more Arabic letters than Latin letters = ar. No letters at all = null (keep the previous language). */
export function detectLang(text: string): Lang | null {
  const ar = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && en === 0) return null;
  return ar >= en ? "ar" : "en";
}

// ---------------------------------------------------------------- vocabulary

const YES = normSet(["نعم", "ايوه", "ايوا", "ايه", "اي", "أيوه", "صح", "صحيح", "تمام", "اوكي", "اوك", "ok", "okay", "yes", "y", "yep", "yeah", "correct", "right", "طبعا", "اكيد", "بلى", "ايوة"]);
const NO = normSet(["لا", "لا لا", "لأ", "لاء", "غلط", "مو صح", "مو صحيح", "مب صحيح", "ليست صحيحة", "no", "n", "nope", "wrong", "incorrect", "مو سيارتي", "مب سيارتي", "مو هذي", "مو هذه"]);
const THANKS = normSet(["شكرا", "شكرا لك", "شكرا جزيلا", "مشكور", "يعطيك العافيه", "الله يعطيك العافيه", "يعطيك العافية", "thanks", "thank you", "thx", "ty", "جزاك الله خير", "الله يجزاك خير", "تسلم", "الله يسلمك", "يسلمو"]);
/**
 * JS `\b` only knows ASCII word characters, so it never matches next to Arabic letters. Rewrite each `\b`
 * into a Unicode-aware lookaround (start boundary after `^ ( |`, otherwise end boundary).
 */
function mk(re: RegExp): RegExp {
  const src = re.source.replace(/\\b/g, (m, offset: number, whole: string) => {
    const prev = whole[offset - 1];
    const isStart = prev === undefined || prev === "(" || prev === "|" || prev === "^";
    return isStart ? "(?<![\\p{L}\\p{N}_])" : "(?![\\p{L}\\p{N}_])";
  });
  return new RegExp(src, "u");
}

const STAFF = [/\bموظف\b/, /\bمسوول\b/, /\bمسؤول\b/, /كلم(?:ني)? احد/, /ابغي اكلم/, /ابي اكلم/, /ابا اكلم/, /اتكلم مع/, /اكلم شخص/, /\b(?:human|agent|staff|person|someone|representative|manager)\b/, /talk to/, /speak (?:to|with)/, /الاداره/, /المدير/, /صاحب المحل/].map(mk);
const RESTART = [/من جديد/, /ابدا من/, /ابدا$/, /الغاء/, /الغي/, /\bstart over\b/, /\brestart\b/, /\breset\b/, /\bcancel\b/, /^ابدا\b/].map(mk);

const GREETING_WORDS = normSet([
  "السلام", "عليكم", "ورحمه", "الله", "وبركاته", "هلا", "هلا والله", "مرحبا", "مرحبتين", "اهلا", "اهلين", "يا", "حياك", "حياكم", "صباح", "مساء", "الخير", "النور", "كيف", "حالك", "شلونك", "شخبارك", "كيفك", "اخبارك", "وش", "علومك", "hi", "hello", "hey", "salam", "good", "morning", "evening", "how", "are", "you", "assalamu", "alaikum", "alaykum", "peace",
]);

/** Filler words removed from the part request before it is sent to OneEPC (kept in this one list for easy review). */
const FILLER_WORDS = normSet([
  "و", "الشاصي", "شاصي", "الشاسي", "شاسي", "رقم", "الهيكل", "هيكل", "تفضل", "اتفضل", "هاك", "هذاك", "vin", "chassis", "number", "no", "ابغى", "ابغا", "ابغي", "ابي", "ابا", "ابى", "اريد", "ابغاه", "ابغاها", "بغيت", "بغينا", "ودي", "تبي", "تبغى", "عندكم", "عندك", "عندكم", "هل", "فيه", "فيها", "يوجد", "متوفر", "متوفره", "موجود", "موجوده", "لو", "سمحت", "فضلك", "من", "ممكن", "تكرمت", "الله", "يعطيك", "العافيه", "لي", "عشان", "مطلوب", "سياره", "سيارتي", "سيارتنا", "لسيارتي", "لسياره", "لدي", "عندي", "في", "على", "علي", "مع", "هذي", "هذا", "هذه", "ذي", "طلب", "نوع", "كم", "سعر", "قطعه", "قطع",
  "i", "need", "want", "looking", "for", "do", "you", "have", "got", "please", "pls", "my", "car", "the", "a", "an", "some", "any", "is", "there", "can", "get", "me", "to", "buy", "of",
]);

/**
 * Gulf possessive particles ("تبع", "حق", "مال" = "of / for"). Dropped on their own, and together with the word
 * after them when that word only says what the part belongs to ("تبع المكينة", "حق الجيب"): the catalogue name
 * already carries that, and the extra words dilute the search score.
 */
const POSSESSIVE_WORDS = normSet(["تبع", "تبعت", "تبعة", "تبعه", "تبعها", "حق", "حقت", "حقة", "حقه", "حقها", "مال", "مالت"]);
const OWNER_WORDS = normSet([
  "المكينة", "المكينه", "مكينة", "مكينه", "المكينة", "المحرك", "محرك", "الماتور", "ماتور", "السيارة", "السياره", "سيارة", "سياره", "سيارتي", "الجيب", "جيب", "الموتر", "موتر", "الوانيت", "وانيت", "الشاص", "engine", "car", "motor",
]);

/** Common model names; stripped (with optional ل prefix) so they do not dilute the part search text. */
const MODEL_WORDS = normSet([
  "كامري", "كورولا", "يارس", "افالون", "راف فور", "برادو", "لاند كروزر", "كروزر", "هايلكس", "هايلكس", "فورتشنر", "انوفا", "اوريون", "ربيزه", "هايس", "كراون", "ربيز", "فيلوز", "تاكوما", "سيكويا", "ريز",
  "النترا", "سوناتا", "اكسنت", "توسان", "سنتافي", "ازيرا", "اكسنت", "كونا", "باليسيد", "كريتا", "ستاريا", "ايلنترا", "فيرنا", "جراند", "جينسس",
  "سبورتاج", "سيراتو", "اوبتيما", "ريو", "سورنتو", "كارنفال", "تيلورايد", "سيلتوس", "بيجاس", "كادينزا", "كي ايه",
  "camry", "corolla", "yaris", "avalon", "hilux", "fortuner", "prado", "land cruiser", "rav4", "elantra", "sonata", "accent", "tucson", "santa fe", "sportage", "cerato", "optima", "sorento", "rio", "seltos",
]);
const MODEL_TOKENS = new Set([...MODEL_WORDS].flatMap((w) => w.split(" ")));

const PARTS_VOCAB = [
  "فحمات", "فحم", "تيل", "فلتر", "فلاتر", "زيت", "فرامل", "فرمله", "بطاريه", "بوجيه", "شمعات", "شمعه", "سير", "ردياتير", "رادياتير", "مساعد", "مساعدات", "ممتص", "كمبروسر", "كمبريسور", "مكينه", "محرك", "قير", "جير", "دبرياج", "ديبرياج", "لمبه", "لمبات", "مرايه", "صدام", "رفرف", "غطاء", "كبوت", "شنطه", "ردياتر", "مضخه", "طرمبه", "مولد", "دينمو", "سلف", "حساس", "طقم", "عمود", "كرنك", "بلف", "بيرنج", "رمان", "مساحات", "مساحه", "كفر", "اطار", "جنط", "قطعه", "قطع", "غيار", "اسطوانه", "فيوز", "ثرموستات", "ترموستات", "دسك", "كوبلن", "عفريته", "رولمان", "جوينت", "جوزه", "زجاج", "شكمان", "مكيف", "كمبرسور", "مروحه", "بخاخ", "بخاخات", "كويل", "كوايل", "هواء", "تيل فرامل", "فحمة", "جلدة", "جلده", "سلندر",
  "brake", "brakes", "pad", "pads", "filter", "oil", "battery", "spark", "plug", "belt", "radiator", "shock", "absorber", "part", "parts", "bumper", "bulb", "mirror", "wiper", "clutch", "gear", "pump", "sensor", "alternator", "starter", "bearing", "gasket", "hose", "axle", "rotor", "disc", "coolant", "headlight", "fender", "hood", "thermostat", "injector", "coil", "spare", "tire", "wheel",
].map(norm);

const OFF_TOPIC = [
  /اكتب(?:ي)? (?:لي|ل)/, /\bقصيد/, /\bشعر\b/, /\bنكت/, /\bمقال/, /تعبير/, /\bترجم/, /\bطقس/, /\bالطقس/, /(?:\bال)?اخبار/, /سياس/, /(?:\bال)?اسهم/, /بيتكوين/, /عملات رقميه/, /\bوصفه/, /طبخ/, /برمج/, /\bكود\b/, /بايثون/, /حل (?:لي|هذا|المسال)/, /واجب/, /رياضيات/, /كم عمرك/, /من صنعك/, /من انت\b/, /وش اسمك/, /شو اسمك/, /انت (?:ذكاء|روبوت|بوت|شات)/, /شات ?جي ?بي ?تي/, /\bchat ?gpt\b/,
  /\b(?:write|poem|joke|story|essay|translate|weather|news|stock|stocks|bitcoin|crypto|recipe|python|javascript|homework|president|capital of|solve|math|politics|football|movie|song|lyrics|horoscope)\b/, /who are you/, /your name/, /how old are you/, /tell me about/, /what is the/, /\bcode\b/,
].map(mk);

// ---------------------------------------------------------------- message parsing

export interface ParsedMessage {
  vin: string | null;
  vinProblem: VinProblem | null;
  lang: Lang | null;
  /** Cleaned part request (filler, greeting, year and model words removed), or null if there is none. */
  partRequest: string | null;
  /** The text contains a car-parts word (فلتر, فحمات, brake...). */
  partsVocab: boolean;
  isGreeting: boolean;
  isYes: boolean;
  isNo: boolean;
  isThanks: boolean;
  wantsStaff: boolean;
  wantsRestart: boolean;
  offTopic: boolean;
}

export interface ParseOptions {
  /** Model names of the current vehicle; stripped from the part request. */
  modelHints?: string[];
}

function cleanTokens(text: string): { orig: string; n: string }[] {
  const cleaned = toLatinDigits(text)
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[^\p{L}\p{N}\s.]/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((orig) => ({ orig, n: norm(orig) }));
}

const isYear = (n: string) => /^(?:19[89]\d|20[0-3]\d)$/.test(n);

/** Strip the optional ل / لـ prefix Gulf customers attach to the model ("لكامري"). */
const stripLam = (n: string) => (n.length > 3 && n.startsWith("ل") ? n.slice(1) : n);

export function cleanPartRequest(text: string, opts: ParseOptions = {}): string | null {
  const hintTokens = new Set((opts.modelHints ?? []).flatMap((h) => norm(h).split(/\s+/)).filter(Boolean));
  const toks = cleanTokens(text);
  const kept = toks.filter(({ n }, i) => {
    if (GREETING_WORDS.has(n) || FILLER_WORDS.has(n) || POSSESSIVE_WORDS.has(n) || isYear(n)) return false;
    if (i > 0 && POSSESSIVE_WORDS.has(toks[i - 1]!.n) && OWNER_WORDS.has(n)) return false; // "تبع المكينة"
    const bare = stripLam(n);
    if (MODEL_TOKENS.has(n) || MODEL_TOKENS.has(bare) || hintTokens.has(n) || hintTokens.has(bare)) return false;
    return true;
  });
  // "وفلتر هواء" (and also a filter) -> "فلتر هواء": drop the conjunction و only when what follows is a known part word.
  const isVocabWord = (n: string) => PARTS_VOCAB.some((w) => n === w || n === stripLam(w) || (n.startsWith("ال") && n.slice(2) === w));
  const out = kept
    .map((t) => (t.n.startsWith("و") && t.n.length > 3 && isVocabWord(t.n.slice(1)) ? t.orig.slice(1) : t.orig))
    .join(" ")
    .trim();
  return out.length > 0 ? out : null;
}

export function hasPartsVocabulary(text: string): boolean {
  const tokens = cleanTokens(text).map((t) => t.n);
  const joined = tokens.join(" ");
  return PARTS_VOCAB.some((w) => tokens.includes(w) || tokens.includes(stripLam(w)) || tokens.some((t) => t.startsWith("ال") && t.slice(2) === w) || (w.includes(" ") && joined.includes(w)));
}

export function parseMessage(text: string, opts: ParseOptions = {}): ParsedMessage {
  const { vin, problem, rest } = extractVin(text);
  const lang = detectLang(rest);
  const tokens = cleanTokens(rest);
  const whole = tokens.map((t) => t.n).join(" ");
  const nRest = norm(rest);

  const isYes = YES.has(whole);
  const isNo = NO.has(whole);
  const isThanks = THANKS.has(whole);
  const wantsStaff = STAFF.some((r) => r.test(nRest));
  const wantsRestart = RESTART.some((r) => r.test(whole));
  const partsVocab = hasPartsVocabulary(rest);
  const offTopic =
    !vin && !partsVocab && !isYes && !isNo && !isThanks && !wantsStaff && !wantsRestart &&
    (OFF_TOPIC.some((r) => r.test(nRest)) || rest.length > 300);

  const hasGreetingToken = tokens.some((t) => GREETING_WORDS.has(t.n));
  const control = isYes || isNo || isThanks || wantsStaff || wantsRestart || offTopic;
  const partRequest = control ? null : cleanPartRequest(rest, opts);
  const isGreeting = !vin && !problem && !control && partRequest === null && hasGreetingToken;

  return { vin, vinProblem: problem, lang, partRequest, partsVocab, isGreeting, isYes, isNo, isThanks, wantsStaff, wantsRestart, offTopic };
}

// ---------------------------------------------------------------- variant choice

const ORDINALS: Array<[RegExp, number]> = [
  [/^(?:ال)?اول(?:ي|ه)?$|^first$|^1st$/, 1],
  [/^(?:ال)?ثاني(?:ه)?$|^ثان(?:ي)?$|^second$|^2nd$/, 2],
  [/^(?:ال)?ثالث(?:ه)?$|^third$|^3rd$/, 3],
  [/^(?:ال)?رابع(?:ه)?$|^fourth$|^4th$/, 4],
  [/^(?:ال)?خامس(?:ه)?$|^fifth$|^5th$/, 5],
];

const vinFieldValues = (c: VehicleRef, fields: string[]): string[] =>
  fields.flatMap((f) => {
    const v = {
      engine: c.engine, trim: c.trim, transmission: c.transmission, market: c.market,
      year: c.year === null ? null : String(c.year), production_date: c.productionDate, model: c.modelEn,
    }[f];
    return v ? [v] : [];
  });

const optionTokens = (s: string): string[] =>
  norm(s)
    .split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, "").replace(/^(\d+(?:\.\d+)?)l$/, "$1"))
    .filter((t) => t.length > 0);

/**
 * Which candidate did the customer pick? Accepts a bare number ("2", "٢", "رقم 2", "2)"), an ordinal
 * ("الثاني", "second") or distinguishing option text ("4.0", "GLX", "V6"). Returns the 0-based index,
 * or null when it is not clear (the engine then asks again rather than guessing).
 */
export function parseVariantChoice(text: string, candidates: VehicleRef[]): number | null {
  const t = norm(text).trim();
  const num = /^(?:رقم|number|no\.?|option|الخيار|خيار)?\s*(\d{1,2})\s*[).:-]?$/.exec(t);
  if (num) {
    const n = Number(num[1]);
    return n >= 1 && n <= candidates.length ? n - 1 : null;
  }
  const words = t.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  for (const w of words) {
    for (const [re, n] of ORDINALS) if (re.test(w) && n <= candidates.length) return n - 1;
  }

  // Option text: use the fields the API says differ; tokens shared by every candidate cannot discriminate.
  const fieldNames = (candidates[0]?.differsBy ?? "").split(/[^a-z_]+/i).map((f) => f.toLowerCase()).filter(Boolean);
  const fields = fieldNames.length ? fieldNames : ["engine", "trim", "transmission", "year"];
  const perCandidate = candidates.map((c) => new Set(vinFieldValues(c, fields).flatMap(optionTokens)));
  const textTokens = new Set(optionTokens(text));
  const matches: number[] = [];
  perCandidate.forEach((tokens, i) => {
    const distinctive = [...tokens].filter((tok) => perCandidate.some((other, j) => j !== i && !other.has(tok)) || perCandidate.length === 1);
    if (distinctive.some((tok) => textTokens.has(tok) && (tok.length > 1 || /\d/.test(tok)))) matches.push(i);
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
