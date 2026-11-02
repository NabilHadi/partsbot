import { z } from "zod";

/**
 * Per-shop bot settings. Stored as JSON in `shops.config` and edited with `npm run shop -- set ...`
 * (src/scripts/shop.ts), which validates with this schema before writing. Anything missing falls back to the
 * defaults below, so an empty `{}` is a valid (and deliberately conservative) configuration. Unknown keys are
 * rejected (a typo must not silently do nothing).
 *
 * Staff WhatsApp numbers are personal data (PDPL). They are stored as plain normalized E.164 strings (no field
 * encryption for now, by Nabil's decision 2026-11-02), are never shown to customers, never sent to the OneEPC
 * gateway, and are only ever printed/logged masked (`maskPhone`: last 4 digits).
 */

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "use HH:MM, 24-hour");
/**
 * One opening window. `close` <= `open` means the window runs past midnight into the next day
 * (e.g. thu 16:00-02:00 is open until Friday 02:00); "24:00" closes exactly at midnight.
 */
const windowSchema = z
  .strictObject({ open: hhmm, close: hhmm })
  .refine((w) => w.open !== w.close, "open and close must differ (use 00:00-24:00 for all day)")
  .refine((w) => w.open !== "24:00", "open cannot be 24:00");

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const DAY_MIN = 24 * 60;
const WEEK_MIN = 7 * DAY_MIN;

const toMinutes = (hhmmValue: string): number => {
  const [h, m] = hhmmValue.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

type Window = z.infer<typeof windowSchema>;
interface Interval { start: number; end: number; weekday: Weekday; open: string }

/** All windows as [start, end) minutes from Sunday 00:00 (end may pass the week end; it wraps to Sunday). */
function weekIntervals(days: Partial<Record<Weekday, Window[]>>): Interval[] {
  const out: Interval[] = [];
  WEEKDAYS.forEach((weekday, d) => {
    for (const w of days[weekday] ?? []) {
      const o = toMinutes(w.open);
      let c = toMinutes(w.close);
      if (c <= o) c += DAY_MIN; // past midnight
      out.push({ start: d * DAY_MIN + o, end: d * DAY_MIN + c, weekday, open: w.open });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}

export const businessHoursSchema = z
  .strictObject({
    /** Fixed to Saudi time for now (UTC+3, no daylight saving). */
    timezone: z.literal("Asia/Riyadh").default("Asia/Riyadh"),
    /** Opening windows per weekday (split shifts = several windows); missing day or [] = closed all day. */
    days: z.partialRecord(z.enum(WEEKDAYS), z.array(windowSchema).max(4)).default({}),
  })
  .superRefine((h, ctx) => {
    const iv = weekIntervals(h.days);
    for (let i = 0; i < iv.length; i++) {
      const a = iv[i] as Interval;
      const b = iv[(i + 1) % iv.length] as Interval;
      if (iv.length < 2) break;
      const bStart = i + 1 < iv.length ? b.start : b.start + WEEK_MIN; // Saturday night into Sunday
      if (a.end > bStart) {
        ctx.addIssue({ code: "custom", message: `opening windows overlap: ${a.weekday} ${a.open} and ${b.weekday} ${b.open}`, path: ["days"] });
        return;
      }
    }
  });
export type BusinessHours = z.infer<typeof businessHoursSchema>;

/** Placeholder hours (Sat-Thu 09:00-22:00, Friday 16:00-22:00). Each shop must set its own. */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  timezone: "Asia/Riyadh",
  days: {
    sat: [{ open: "09:00", close: "22:00" }],
    sun: [{ open: "09:00", close: "22:00" }],
    mon: [{ open: "09:00", close: "22:00" }],
    tue: [{ open: "09:00", close: "22:00" }],
    wed: [{ open: "09:00", close: "22:00" }],
    thu: [{ open: "09:00", close: "22:00" }],
    fri: [{ open: "16:00", close: "22:00" }],
  },
};

/** Saudi mobiles in any common form -> E.164 (+9665XXXXXXXX); other countries must already be +<country><number>. */
export function normalizeWhatsAppNumber(input: string): string | null {
  const s = input.replace(/[\s\-().]/g, "").replace(/^00/, "+");
  if (/^05\d{8}$/.test(s)) return `+966${s.slice(1)}`;
  if (/^5\d{8}$/.test(s)) return `+966${s}`;
  if (/^9665\d{8}$/.test(s)) return `+${s}`;
  if (/^\+9665\d{8}$/.test(s)) return s;
  if (/^\+966/.test(s)) return null; // Saudi but not a mobile: WhatsApp needs a mobile
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  return null;
}

/** "•••••••••4567": the last 4 digits only. The ONLY form a staff number may take in logs and CLI output. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `•••••••••${digits.slice(-4)}`;
}

export const staffMemberSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  /** WhatsApp number, normalized E.164 (+9665XXXXXXXX). Set via `npm run shop -- staff-add` (normalizes). */
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "phone must be a normalized E.164 number (use: npm run shop -- staff-add)"),
  /** Receives handoff notifications (the notification sender is the next step; only stored for now). */
  notify: z.boolean().default(true),
});
export type StaffMember = z.infer<typeof staffMemberSchema>;

export const STOCK_DISPLAY = ["hidden", "availability", "quantity"] as const;
export type StockDisplay = (typeof STOCK_DISPLAY)[number];
export const AFTER_HOURS_MODES = ["reply_with_note", "note_only"] as const;
export type AfterHoursMode = (typeof AFTER_HOURS_MODES)[number];

export const AI_PROVIDER_CHOICES = ["server_default", "gemini", "deepseek", "openrouter"] as const;

export const shopConfigSchema = z.strictObject({
  // ---- what the customer is shown ----
  /** Show the shop's price next to stock lines (src/inventory). Off = never a price. */
  priceQuotingEnabled: z.boolean().default(false),
  /**
   * Show the OneEPC part number in replies. Off = the part is named only (Arabic catalogue name); the number is
   * still identified, logged (`parts_identified`) and kept in the conversation state for staff, never shown.
   */
  showPartNumbers: z.boolean().default(true),
  /** `hidden` = no stock line; `availability` = متوفر / غير متوفر only; `quantity` = exact count. */
  stockDisplay: z.enum(STOCK_DISPLAY).default("availability"),
  /** Show alternative variants of the same base number (CH / J / DENSO ... rows of the shop's list). */
  showAlternatives: z.boolean().default(true),
  /** `ar` (default) or `en` always; `auto` = the script of the customer's last message. */
  language: z.enum(["ar", "en", "auto"]).default("ar"),
  /** Shown in the welcome line when set, e.g. "قطع غيار الأمل". Empty = omitted. */
  shopName: z.string().max(80).default(""),

  // ---- hours and staff ----
  businessHours: businessHoursSchema.default(DEFAULT_BUSINESS_HOURS),
  /**
   * Outside opening hours: `reply_with_note` = answer as usual and add ONE "closed now, staff follow up from <time>"
   * note (once per closed period); `note_only` = send only that note (once per closed period), no lookup.
   */
  afterHoursMode: z.enum(AFTER_HOURS_MODES).default("reply_with_note"),
  /** Who the customer is told will follow up (e.g. "أبو فهد"). Empty = "الموظف". */
  staffHandoffName: z.string().max(80).default(""),
  /** PUBLIC shop line shown to customers in handoff replies (not a personal number). Empty = none. */
  staffHandoffPhone: z.string().max(30).default(""),
  /** Staff who handle handoffs (names + WhatsApp numbers). Never shown to customers or logged. */
  staff: z.array(staffMemberSchema).max(10).default([]),

  // ---- stock data ----
  /** A test shop (Nabil's own number). Only a test shop may ever see synthetic stock. */
  testShop: z.boolean().default(false),
  /** Show SYNTHETIC stock rows (generated qty/price). Has no effect unless `testShop` is true. */
  allowSyntheticStock: z.boolean().default(false),
  /** Stock older than this many days is not shown; the reply says staff confirm availability (with the date). */
  stockStaleDays: z.number().int().min(1).max(365).default(7),

  // ---- limits ----
  /** Bot messages per shop per day (Asia/Riyadh); at the cap the bot sends ONE final handoff message, then goes silent. */
  maxBotMessagesPerDay: z.number().int().min(1).max(10_000).default(40),
  /** Inactivity after which a conversation restarts from scratch. */
  sessionTtlMinutes: z.number().int().min(5).max(7 * 24 * 60).default(120),
  /** How long the bot stays silent after a handoff (staff are handling the chat). */
  handoffSilenceMinutes: z.number().int().min(5).max(7 * 24 * 60).default(720),
  /** At most this many parts are listed in one reply. */
  maxPartsPerReply: z.number().int().min(1).max(10).default(3),
  /** AI understanding + reply wording (src/ai). Needs the global AI_ENABLED too. Off for new shops. */
  aiEnabled: z.boolean().default(false),
  /** Which AI provider this shop uses; server_default = AI_PROVIDER. A provider without a key on the server falls back to the default. */
  aiProvider: z.enum(AI_PROVIDER_CHOICES).default("server_default"),
});
export type ShopConfig = z.infer<typeof shopConfigSchema>;

export function parseShopConfig(input: unknown): ShopConfig {
  return shopConfigSchema.parse(input ?? {});
}

export const DEFAULT_SHOP_CONFIG: ShopConfig = parseShopConfig({});

// ---- Time helpers (Asia/Riyadh) ----

export interface LocalTime {
  weekday: Weekday;
  /** Minutes since local midnight. */
  minutes: number;
  /** Local calendar date, YYYY-MM-DD. */
  dateKey: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localTime(now: Date, timezone = "Asia/Riyadh"): LocalTime {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = (parts.weekday ?? "Sun").slice(0, 3).toLowerCase() as Weekday;
  return {
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export type Availability =
  | { open: true }
  /** `dayOffset` 0 = later today, 1 = tomorrow, 2..7 = a named day. `next` is null when no hours are configured at all. */
  | { open: false; next: { dayOffset: number; weekday: Weekday; time: string } | null };

/** Are staff in now (split shifts and windows past midnight included), and if not when do they next open? */
export function staffAvailability(now: Date, hours: BusinessHours): Availability {
  const local = localTime(now, hours.timezone);
  const at = WEEKDAYS.indexOf(local.weekday) * DAY_MIN + local.minutes;
  const iv = weekIntervals(hours.days);
  if (iv.length === 0) return { open: false, next: null };
  // A window that started late on Saturday wraps into Sunday morning: check both `at` and `at + week`.
  if (iv.some((w) => (at >= w.start && at < w.end) || (at + WEEK_MIN >= w.start && at + WEEK_MIN < w.end))) return { open: true };
  let best: Interval | null = null;
  let bestDelta = Infinity;
  for (const w of iv) {
    const delta = (w.start - at + WEEK_MIN) % WEEK_MIN || WEEK_MIN;
    if (delta < bestDelta) [best, bestDelta] = [w, delta];
  }
  if (!best) return { open: false, next: null };
  return { open: false, next: { dayOffset: Math.floor((local.minutes + bestDelta) / DAY_MIN), weekday: best.weekday, time: best.open } };
}

/**
 * Identifies the current closed period by its next opening ("2026-10-31 08:00"), so the after-hours note is
 * sent once per closed period. null = open now, or no hours configured (then there is no after-hours behaviour).
 */
export function closedPeriodKey(now: Date, hours: BusinessHours): string | null {
  const a = staffAvailability(now, hours);
  if (a.open || !a.next) return null;
  const nextDay = localTime(new Date(now.getTime() + a.next.dayOffset * DAY_MIN * 60_000), hours.timezone).dateKey;
  return `${nextDay} ${a.next.time}`;
}
