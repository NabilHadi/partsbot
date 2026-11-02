/**
 * ALL customer-facing text lives in this file, for easy review by the shop owner.
 * Arabic is short, polite, Saudi-leaning; English is the fallback for customers who write in Latin letters.
 *
 * Rules every template follows:
 *  - One message per turn: the engine joins pieces with a blank line, so keep each template self-contained.
 *  - No part number is ever typed here. Part numbers only enter a reply through `partsQuoted` items that
 *    come from OneEPC (and the runtime guard in guard.ts re-checks that).
 *  - Stock and prices come only from the shop's own imported list (src/inventory), shown under the OneEPC
 *    number as availability per variant (origin / brand label + the shop's suffix code, never a new number).
 *    Prices only when the shop turned price quoting on. Every stock reply still ends with "staff confirm".
 *    Synthetic (generated) stock is marked «(بيانات تجريبية)» and only ever reaches a test shop.
 *  - The exact wording «يرجى التأكيد مع الموظف» is used whenever fitment is not confirmed.
 *  - The bot never claims to be a person and only talks about car-parts enquiries.
 */
import type { Availability, ShopConfig, StockDisplay, Weekday } from "./shop-config.js";
import type { Lang } from "./intent.js";

type Msg<P = void> = { ar: (p: P) => string; en: (p: P) => string };

export const CONFIRM_WITH_STAFF_AR = "يرجى التأكيد مع الموظف";
export const CONFIRM_WITH_STAFF_EN = "Please confirm with our staff";

// ------------------------------------------------------------------ small fragments

const WEEKDAY_AR: Record<Weekday, string> = { sun: "الأحد", mon: "الاثنين", tue: "الثلاثاء", wed: "الأربعاء", thu: "الخميس", fri: "الجمعة", sat: "السبت" };
const WEEKDAY_EN: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

function clock12(hhmm: string, lang: Lang): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = mStr ?? "00";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (lang === "en") return `${h12}:${m} ${h >= 12 && h < 24 ? "PM" : "AM"}`;
  const suffix = h < 12 ? "صباحاً" : h < 15 ? "ظهراً" : h < 18 ? "عصراً" : "مساءً";
  return `${h12}:${m} ${suffix}`;
}

type NextOpening = NonNullable<Extract<Availability, { open: false }>["next"]>;

/** "بكرة الساعة 8:00 صباحاً" / "tomorrow at 8:00 AM": when staff are next in. */
export function whenText(lang: Lang, next: NextOpening): string {
  const { dayOffset, weekday, time } = next;
  if (lang === "ar") {
    const day = dayOffset === 0 ? "اليوم" : dayOffset === 1 ? "بكرة" : `يوم ${WEEKDAY_AR[weekday]}`;
    return `${day} الساعة ${clock12(time, "ar")}`;
  }
  const day = dayOffset === 0 ? "today" : dayOffset === 1 ? "tomorrow" : `on ${WEEKDAY_EN[weekday]}`;
  return `${day} at ${clock12(time, "en")}`;
}

/**
 * "When will staff answer?" fragment, built from the shop's business hours (Asia/Riyadh).
 * Intent: set an honest expectation, so the customer is not left wondering at midnight.
 * Only the PUBLIC shop line (`staffHandoffPhone`) may appear; staff members' own numbers never do.
 */
export function staffFollowUp(lang: Lang, cfg: Pick<ShopConfig, "staffHandoffName" | "staffHandoffPhone">, avail: Availability): string {
  const who = cfg.staffHandoffName || (lang === "ar" ? "الموظف" : "Our team");
  const phone = cfg.staffHandoffPhone;
  let line: string;
  if (avail.open) {
    line = lang === "ar" ? `${who} بيرد عليك بأقرب وقت.` : `${who} will reply shortly.`;
  } else if (!avail.next) {
    line = lang === "ar" ? `${who} بيرد عليك بإذن الله.` : `${who} will get back to you.`;
  } else {
    line = lang === "ar" ? `${who} بيرد عليك ${whenText("ar", avail.next)} بإذن الله.` : `${who} will reply ${whenText("en", avail.next)}.`;
  }
  if (phone) line += lang === "ar" ? ` للتواصل المباشر: ${phone}` : ` Direct line: ${phone}`;
  return line;
}

// ------------------------------------------------------------------ templates

export interface PartLine {
  name: string;
  /** The OneEPC number, or null when the shop hides part numbers (then the part is identified by name only). */
  partNumber: string | null;
  /** The shop's stock for this number (absent = no row in the shop's list, or stock is stale). */
  stock?: PartStockView;
}

export interface StockQtyView {
  qty: number | null;
  /** Already gated: null unless the shop quotes prices. */
  priceSar: number | null;
}

export interface StockVariantView extends StockQtyView {
  kind: "origin" | "brand" | "unknown" | "none";
  /** The shop's suffix code as written ("J", "CH", "DENSO", "E"); short, never a full part number. */
  code: string | null;
  labelAr: string | null;
  labelEn: string | null;
  unconfirmed: boolean;
}

export interface PartStockView {
  /** How much the shop lets us say: `quantity` = exact count, `availability` = in/out only, `hidden` = price only (if any). */
  display: StockDisplay;
  /** Same number as OneEPC (no suffix). Not called "genuine": the data does not say so. */
  exact: StockQtyView | null;
  variants: StockVariantView[];
}

export interface StockFooter {
  /** Riyadh date of the stock import, YYYY-MM-DD. */
  asOf: string;
  stale: boolean;
  synthetic: boolean;
  /** At least one price is shown (adds the VAT note). */
  pricesShown: boolean;
  /** Availability is shown (stockDisplay is not `hidden`). */
  stockShown: boolean;
}

function priceText(sar: number, lang: Lang): string {
  return lang === "ar" ? `${sar} ريال` : `SAR ${sar}`;
}

/** One stock fragment, or null when there is nothing the shop allows us to say. */
function qtyText(q: StockQtyView, display: StockDisplay, lang: Lang): string | null {
  let avail: string | null;
  if (display === "hidden") avail = null;
  else if (q.qty === null) avail = lang === "ar" ? (display === "quantity" ? "الكمية غير محددة" : "التوفر غير محدد") : display === "quantity" ? "quantity not listed" : "availability not listed";
  else if (q.qty > 0) avail = display === "quantity" ? (lang === "ar" ? `متوفر (${q.qty})` : `in stock (${q.qty})`) : lang === "ar" ? "متوفر" : "in stock";
  else avail = lang === "ar" ? "غير متوفر حالياً" : "out of stock";
  if (q.priceSar === null) return avail;
  if (avail === null) return lang === "ar" ? `السعر ${priceText(q.priceSar, lang)}` : `price ${priceText(q.priceSar, lang)}`;
  return `${avail} · ${priceText(q.priceSar, lang)}`;
}

/** With part numbers hidden the suffix code is dropped too: the label (ياباني / DENSO) is enough. */
function variantLabel(v: StockVariantView, lang: Lang, showCodes: boolean): string {
  const label = lang === "ar" ? v.labelAr : v.labelEn;
  const unconf = lang === "ar" ? "غير مؤكد" : "unconfirmed";
  if (!showCodes) {
    if (v.kind === "origin" || v.kind === "brand") return `${label}${v.unconfirmed ? ` (${unconf})` : ""}`;
    return lang === "ar" ? `بديل آخر (${unconf})` : `other variant (${unconf})`;
  }
  if (v.kind === "origin") return `${label} (${v.code})${v.unconfirmed ? ` ${unconf}` : ""}`;
  if (v.kind === "brand") return `${label}${v.unconfirmed ? ` (${v.code}${lang === "ar" ? "، " : ", "}${unconf})` : ""}`;
  return lang === "ar" ? `رمز ${v.code} (${unconf})` : `code ${v.code} (${unconf})`;
}

function stockLines(item: PartLine, lang: Lang): string[] {
  const s = item.stock;
  if (!s) return [];
  const showCodes = item.partNumber !== null;
  const out: string[] = [];
  const exact = s.exact ? qtyText(s.exact, s.display, lang) : null;
  if (exact) {
    const label = showCodes ? (lang === "ar" ? "نفس الرقم" : "Same number") : lang === "ar" ? "نفس القطعة" : "This part";
    out.push(`  ${label}: ${exact}`);
  }
  const variants = s.variants.flatMap((v) => {
    const q = qtyText(v, s.display, lang);
    return q ? [`  - ${variantLabel(v, lang, showCodes)}: ${q}`] : [];
  });
  if (variants.length > 0) {
    out.push(showCodes ? (lang === "ar" ? "  بدائل بنفس الرقم الأساسي:" : "  Variants of the same base number:") : lang === "ar" ? "  بدائل للقطعة نفسها:" : "  Alternatives for the same part:");
    out.push(...variants);
  }
  return out;
}

function partsHeader(items: PartLine[], lang: Lang): string {
  const one = items.length === 1;
  if (items.some((i) => i.partNumber !== null)) {
    if (lang === "ar") return one ? "حسب الكتالوج، رقم القطعة لسيارتك:" : "حسب الكتالوج، أرقام القطع لسيارتك:";
    return one ? "According to the catalogue, the part number for your car:" : "According to the catalogue, the part numbers for your car:";
  }
  if (lang === "ar") return one ? "حسب الكتالوج، القطعة المناسبة لسيارتك:" : "حسب الكتالوج، القطع المناسبة لسيارتك:";
  return one ? "According to the catalogue, the part that fits your car:" : "According to the catalogue, the parts that fit your car:";
}

function stockFooter(f: StockFooter | null, lang: Lang): string[] {
  if (!f) return [lang === "ar" ? "الموظف يؤكد لك التوفر." : "Our staff will confirm availability."];
  const out: string[] = [];
  if (f.stale) {
    out.push(lang === "ar" ? `بيانات المخزون قديمة (آخر تحديث ${f.asOf})، الموظف يؤكد لك التوفر.` : `Stock data is old (last update ${f.asOf}); our staff will confirm availability.`);
  } else {
    const vat = f.pricesShown ? (lang === "ar" ? " الأسعار شاملة الضريبة." : " Prices include VAT.") : "";
    if (f.stockShown) out.push(lang === "ar" ? `المخزون حسب تحديث ${f.asOf}.${vat} الموظف يؤكد لك التوفر.` : `Stock as of ${f.asOf}.${vat} Our staff will confirm availability.`);
    else out.push(lang === "ar" ? `الأسعار حسب تحديث ${f.asOf}.${vat} الموظف يؤكد لك التوفر والسعر.` : `Prices as of ${f.asOf}.${vat} Our staff will confirm availability and price.`);
  }
  if (f.synthetic) out.push(lang === "ar" ? "(بيانات تجريبية)" : "(test data)");
  return out;
}

/**
 * The facts part of a quote (items, stock lines, "not confirmed" note, stock footer). Rendered ONLY by code;
 * when the AI writes the surrounding reply it sees this as "[[PARTS]]" and code puts the exact text back.
 */
export function renderPartsBlock(lang: Lang, p: { items: PartLine[]; staffNote: boolean; stock?: StockFooter | null }): string {
  return [
    ...p.items.flatMap((i) => [i.partNumber ? `• ${i.name}: ${i.partNumber}` : `• ${i.name}`, ...stockLines(i, lang)]),
    ...(p.staffNote ? [lang === "ar" ? `وفيه نتائج ثانية ما تأكد تطابقها، ${CONFIRM_WITH_STAFF_AR}.` : `Other results are not confirmed to fit. ${CONFIRM_WITH_STAFF_EN}.`] : []),
    ...stockFooter(p.stock ?? null, lang),
  ].join("\n");
}

export const T = {
  /** First reply to a new customer with no request yet: say who we are (automated), what we need (VIN) and what we do. */
  welcomeAskVin: {
    ar: (p: { shopName: string }) =>
      `هلا والله وغلا 👋 أنا المساعد الآلي ${p.shopName ? `لـ${p.shopName}` : "لمحل قطع الغيار"}، أساعدك تعرف رقم القطعة المناسبة لسيارتك.\nأرسل لي رقم الشاصي (VIN) من استمارة السيارة، 17 خانة، واكتب القطعة اللي تحتاجها.`,
    en: (p: { shopName: string }) =>
      `Welcome 👋 I'm the automated assistant ${p.shopName ? `of ${p.shopName}` : "of this auto-parts shop"}. I help you find the right part number for your car.\nPlease send your VIN (17 characters, from the car registration card) and tell me which part you need.`,
  },

  /** First reply when the customer already named a part: acknowledge it, ask only for the VIN. */
  welcomeAskVinWithRequest: {
    ar: (p: { shopName: string }) =>
      `هلا والله وغلا 👋 أنا المساعد الآلي ${p.shopName ? `لـ${p.shopName}` : "لمحل قطع الغيار"}.\nوصلني طلبك 👍 عشان أحدد لك القطعة بدقة أرسل لي رقم الشاصي (VIN) من استمارة السيارة، 17 خانة.`,
    en: (p: { shopName: string }) =>
      `Welcome 👋 I'm the automated assistant ${p.shopName ? `of ${p.shopName}` : "of this auto-parts shop"}.\nGot your request 👍 To find the exact part, please send your VIN (17 characters, from the car registration card).`,
  },

  /** Later turns: a part request is known, VIN still missing. */
  askVinWithRequest: {
    ar: () => "أبشر، عشان أحدد لك القطعة بدقة أحتاج رقم الشاصي (VIN) من استمارة السيارة، 17 خانة. أرسله لي وأكمل لك الطلب.",
    en: () => "Sure. To find the exact part I need your VIN (17 characters, from the registration card). Send it and I'll continue.",
  },

  /** Later turns: nothing known yet (e.g. just a greeting or "yes"). */
  askVin: {
    ar: () => "أرسل لي رقم الشاصي (VIN) من استمارة السيارة، 17 خانة، واكتب القطعة اللي تحتاجها.",
    en: () => "Please send your VIN (17 characters, from the registration card) and tell me which part you need.",
  },

  /**
   * The text looked like a VIN but was not valid: explain once, simply. `bad_chars` = contains I/O/Q, `bad_length` = not 17,
   * `frame_number` = a frame number (only 17-character VINs are accepted for now).
   */
  invalidVin: {
    ar: (p: { problem: "bad_chars" | "bad_length" | "frame_number" }) =>
      p.problem === "bad_chars"
        ? "رقم الشاصي فيه حرف غير مقبول 🙏 الرقم الصحيح 17 خانة وما فيه الحروف I و O و Q (غالباً تكون الصفر 0 أو الرقم 1). تأكد من الاستمارة وأرسله مرة ثانية."
        : p.problem === "frame_number"
          ? "هذا رقم الفريم (الإطار) 🙏 حالياً نحتاج رقم الهيكل / الشاصي (VIN) من استمارة السيارة، 17 خانة (حروف وأرقام). أرسله لي وأكمل لك."
          : "رقم الشاصي اللي وصلني مو مضبوط 🙏 لازم يكون 17 خانة (حروف وأرقام). تأكد من الاستمارة وأرسله مرة ثانية.",
    en: (p: { problem: "bad_chars" | "bad_length" | "frame_number" }) =>
      p.problem === "bad_chars"
        ? "That VIN contains a letter that is not allowed 🙏 A VIN has 17 characters and never contains the letters I, O or Q (usually it is the digit 0 or 1). Please check the card and send it again."
        : p.problem === "frame_number"
          ? "That looks like a frame number 🙏 For now I need the VIN: 17 characters (letters and digits), from the registration card. Please send it and I'll continue."
          : "That VIN doesn't look complete 🙏 It must be exactly 17 characters (letters and digits). Please check the card and send it again.",
  },

  /** Exact decode, no part request yet: one-line vehicle confirmation, ask yes/no, ask for the part. */
  vehicleConfirmAskPart: {
    ar: (p: { vehicle: string }) => `🚗 ${p.vehicle}\nهذي سيارتك؟ رد بـ نعم أو لا، واكتب لي القطعة اللي تحتاجها.`,
    en: (p: { vehicle: string }) => `🚗 ${p.vehicle}\nIs this your car? Reply yes or no, and tell me which part you need.`,
  },

  /** Exact decode and the part request is already known: confirm the car in one line, results follow in the same message. */
  vehicleLine: {
    ar: (p: { vehicle: string }) => `🚗 ${p.vehicle}`,
    en: (p: { vehicle: string }) => `🚗 ${p.vehicle}`,
  },

  /** The customer answered "no" to the vehicle line. */
  vehicleRejected: {
    ar: () => "تمام، ما هي سيارتك. أرسل لي رقم الشاصي (VIN) الصحيح من الاستمارة.",
    en: () => "OK, that's not your car. Please send the correct VIN from the registration card.",
  },

  /** Vehicle confirmed ("yes") but we still need the part. */
  askPart: {
    ar: () => "تمام 👍 وش القطعة اللي تحتاجها؟",
    en: () => "Great 👍 Which part do you need?",
  },

  /** Ambiguous VIN: ONE question, numbered options (labels are built from API data in engine.ts). */
  variantQuestion: {
    ar: (p: { options: string[] }) => `هالشاصي ينطبق على أكثر من نسخة، أي وحدة سيارتك؟\n${p.options.map((o, i) => `${i + 1}) ${o}`).join("\n")}\nرد برقم الخيار.`,
    en: (p: { options: string[] }) => `This VIN matches more than one version. Which one is your car?\n${p.options.map((o, i) => `${i + 1}) ${o}`).join("\n")}\nReply with the option number.`,
  },

  /** The reply to the variant question was not understood. */
  variantReask: {
    ar: (p: { options: string[] }) => `ما قدرت أحدد اختيارك 🙏 رد برقم الخيار بس:\n${p.options.map((o, i) => `${i + 1}) ${o}`).join("\n")}`,
    en: (p: { options: string[] }) => `I couldn't tell which one you meant 🙏 Please reply with just the option number:\n${p.options.map((o, i) => `${i + 1}) ${o}`).join("\n")}`,
  },

  /**
   * Confirmed parts only. `items` come from OneEPC results with fitment 'confirmed' and no ambiguity.
   * `staffNote` = some other results were not confirmed; `askAck` = remind them to say "no" if the car is wrong.
   */
  partsQuoted: {
    ar: (p: { items: PartLine[]; staffNote: boolean; askAck: boolean; stock?: StockFooter | null }) =>
      [
        partsHeader(p.items, "ar"),
        renderPartsBlock("ar", p),
        ...(p.askAck ? ["وإذا السيارة مو صحيحة رد بـ لا. وتبي قطعة ثانية؟ اكتبها لي."] : ["تبي قطعة ثانية؟ اكتبها لي."]),
      ].join("\n"),
    en: (p: { items: PartLine[]; staffNote: boolean; askAck: boolean; stock?: StockFooter | null }) =>
      [
        partsHeader(p.items, "en"),
        renderPartsBlock("en", p),
        ...(p.askAck ? ["If this isn't your car, reply no. Need another part? Just write it."] : ["Need another part? Just write it."]),
      ].join("\n"),
  },

  /** Results exist but none is confirmed to fit (conditional/unknown) and the API gave no question: never present as fitting. */
  needStaffConfirm: {
    ar: (p: { followUp: string }) => `لقيت نتائج بس ما أقدر أأكد إنها تناسب سيارتك. ${CONFIRM_WITH_STAFF_AR}. ${p.followUp}`,
    en: (p: { followUp: string }) => `I found results but cannot confirm they fit your car. ${CONFIRM_WITH_STAFF_EN}. ${p.followUp}`,
  },

  /** The search is ambiguous: ask the API's own question (question_hint), nothing else. Text is shown as received, never translated. */
  clarification: {
    ar: (p: { question: string }) => `عشان أحدد القطعة بدقة: ${p.question}`,
    en: (p: { question: string }) => `To find the exact part: ${p.question}`,
  },

  /** Search found nothing: ask once for a different description. */
  noResults: {
    ar: () => "ما لقيت نتيجة بهالوصف 🙏 جرب تكتب اسم القطعة بشكل ثاني أو أوضح.",
    en: () => "I found nothing for that description 🙏 Try naming the part differently or more specifically.",
  },

  /**
   * Several parts asked in one message (AI path): the ones the catalogue could not confirm, by canonical name.
   * `names` are synonym-list / normalized names, never customer text with numbers.
   */
  partsUnresolved: {
    ar: (p: { names: string[] }) => `وما قدرت أأكد من الكتالوج: ${p.names.join("، ")}. ${CONFIRM_WITH_STAFF_AR}، أو اكتب لي وصف أوضح.`,
    en: (p: { names: string[] }) => `I couldn't confirm these from the catalogue: ${p.names.join(", ")}. ${CONFIRM_WITH_STAFF_EN}, or describe them more clearly.`,
  },

  // ---- handoffs: each one tells the customer staff will follow up, nothing else ----
  handoffGeneric: {
    ar: (p: { followUp: string }) => `تمام، حولت طلبك للموظف عشان يراجعه بدقة. ${p.followUp}`,
    en: (p: { followUp: string }) => `Okay, I've passed your request to our staff to check carefully. ${p.followUp}`,
  },
  handoffRequested: {
    ar: (p: { followUp: string }) => `أبشر، حولتك للموظف. ${p.followUp}`,
    en: (p: { followUp: string }) => `Of course, I've passed you to our staff. ${p.followUp}`,
  },
  handoffUnknownVin: {
    ar: (p: { followUp: string }) => `ما لقيت هالشاصي في الكتالوج عندي، بخلي الموظف يتأكد لك. ${p.followUp}`,
    en: (p: { followUp: string }) => `I couldn't find this VIN in my catalogue, so our staff will check for you. ${p.followUp}`,
  },
  handoffUnsupportedBrand: {
    ar: (p: { followUp: string }) => `هالماركة ما أقدر أبحث فيها من عندي، بخلي الموظف يتأكد لك. ${p.followUp}`,
    en: (p: { followUp: string }) => `I can't search this brand myself, so our staff will check for you. ${p.followUp}`,
  },
  handoffNoResults: {
    ar: (p: { followUp: string }) => `ما قدرت ألقى القطعة في الكتالوج، بخلي الموظف يتأكد لك. ${p.followUp}`,
    en: (p: { followUp: string }) => `I couldn't find the part in the catalogue, so our staff will check for you. ${p.followUp}`,
  },
  /** Any OneEPC/system failure. Never contains the error text. */
  handoffError: {
    ar: (p: { followUp: string }) => `عذراً، صار عندي خلل بسيط وما قدرت أكمل طلبك 🙏 ${p.followUp}`,
    en: (p: { followUp: string }) => `Sorry, something went wrong on my side and I couldn't finish your request 🙏 ${p.followUp}`,
  },
  handoffTooManyVariants: {
    ar: (p: { followUp: string }) => `هالشاصي له نسخ كثيرة وما أقدر أحدد بدقة، بخلي الموظف يتأكد لك. ${p.followUp}`,
    en: (p: { followUp: string }) => `This VIN has too many versions for me to pick safely, so our staff will check. ${p.followUp}`,
  },
  /** Daily message cap reached: sent ONCE, then the bot is silent until the next day. */
  capReached: {
    ar: (p: { followUp: string }) => `وصلنا للحد اليومي لرسائل المساعد الآلي. بخلي الموظف يكمل معك. ${p.followUp}`,
    en: (p: { followUp: string }) => `The assistant has reached its daily message limit. Our staff will continue with you. ${p.followUp}`,
  },

  /**
   * After hours, `reply_with_note`: appended ONCE per closed period to a normal reply (not to handoff replies,
   * which already say when staff answer). `when` comes from whenText().
   */
  afterHoursNote: {
    ar: (p: { when: string }) => `⏰ المحل مسكّر الحين، والموظف بيتابع معك ${p.when} بإذن الله.`,
    en: (p: { when: string }) => `⏰ The shop is closed now; our staff will follow up ${p.when}.`,
  },
  /** After hours, `note_only`: the whole reply, ONCE per closed period (later messages wait silently for staff). */
  afterHoursOnly: {
    ar: (p: { when: string; shopName: string }) =>
      `هلا والله 👋 ${p.shopName ? `${p.shopName} مسكّر` : "المحل مسكّر"} الحين، والموظف بيتابع معك ${p.when} بإذن الله.\nاكتب طلبك هنا (رقم الشاصي واسم القطعة) عشان يكون جاهز له.`,
    en: (p: { when: string; shopName: string }) =>
      `Hello 👋 ${p.shopName || "The shop"} is closed now; our staff will follow up ${p.when}.\nPlease leave your request here (VIN and part name) so it is ready for them.`,
  },

  /** Scope guard (Meta bans general-purpose AI assistants): one polite line, offer staff. */
  offTopic: {
    ar: () => "أنا مساعد قطع الغيار فقط 🙏 أقدر أساعدك في استفسارات القطع. وإذا تبي تكلم الموظف اكتب: موظف",
    en: () => "I can only help with car-parts enquiries 🙏 If you'd like to speak to our staff, write: staff",
  },

  /** Voice note, photo, sticker...: not supported in this step. */
  nonText: {
    ar: () => "حالياً أستقبل الرسائل النصية بس 🙏 اكتب لي رقم الشاصي (VIN) واسم القطعة.",
    en: () => "For now I can only read text messages 🙏 Please type your VIN and the part name.",
  },

  /** Customer said "start over". */
  restart: {
    ar: () => "تمام، نبدأ من جديد. أرسل لي رقم الشاصي (VIN) واسم القطعة.",
    en: () => "OK, let's start over. Please send your VIN and the part name.",
  },
} satisfies Record<string, Msg<never>>;

export type TemplateName = keyof typeof T;

type ParamsOf<K extends TemplateName> = Parameters<(typeof T)[K]["ar"]>[0];

/** Render a template in the given language. Usage: render(lang, "askPart") or render(lang, "invalidVin", { problem }). */
export function render<K extends TemplateName>(lang: Lang, name: K, ...params: ParamsOf<K> extends undefined ? [] : [ParamsOf<K>]): string {
  const tpl = T[name] as unknown as { ar: (p?: unknown) => string; en: (p?: unknown) => string };
  return tpl[lang](params[0]);
}
