import { z } from "zod";

/**
 * Per-shop bot settings. Stored as JSON in `shops.config`; anything missing falls back to the defaults
 * below, so an empty `{}` is a valid (and deliberately conservative) configuration.
 */

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "use HH:MM, 24-hour");
const windowSchema = z
  .object({ open: hhmm, close: hhmm })
  .refine((w) => w.open < w.close, "open must be before close");

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const businessHoursSchema = z.object({
  /** Fixed to Saudi time for now (UTC+3, no daylight saving). */
  timezone: z.literal("Asia/Riyadh").default("Asia/Riyadh"),
  /** Opening windows per weekday; an empty list = closed all day. */
  days: z.partialRecord(z.enum(WEEKDAYS), z.array(windowSchema)).default({}),
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

export const shopConfigSchema = z.object({
  /** Not used yet: this step never mentions prices, whatever the value. */
  priceQuotingEnabled: z.boolean().default(false),
  /** `auto` = answer in the script of the customer's last message (Arabic unless they write Latin letters). */
  language: z.enum(["ar", "en", "auto"]).default("auto"),
  /** Shown in the welcome line when set, e.g. "قطع غيار الأمل". Empty = omitted. */
  shopName: z.string().max(80).default(""),
  /** Who the customer is told will follow up, and an optional direct number (PLACEHOLDER, empty by default). */
  staffHandoffName: z.string().max(80).default(""),
  staffHandoffPhone: z.string().max(30).default(""),
  businessHours: businessHoursSchema.default(DEFAULT_BUSINESS_HOURS),
  /** Bot messages per shop per day (Asia/Riyadh); at the cap the bot sends ONE final handoff message, then goes silent. */
  maxBotMessagesPerDay: z.number().int().min(1).max(10_000).default(40),
  /** Inactivity after which a conversation restarts from scratch. */
  sessionTtlMinutes: z.number().int().min(5).max(7 * 24 * 60).default(120),
  /** How long the bot stays silent after a handoff (staff are handling the chat). */
  handoffSilenceMinutes: z.number().int().min(5).max(7 * 24 * 60).default(720),
  /** At most this many part numbers are quoted in one reply. */
  maxPartsPerReply: z.number().int().min(1).max(10).default(3),
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

const toMinutes = (hhmmValue: string): number => {
  const [h, m] = hhmmValue.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export type Availability =
  | { open: true }
  /** `dayOffset` 0 = later today, 1 = tomorrow, 2..7 = a named day. `next` is null when no hours are configured at all. */
  | { open: false; next: { dayOffset: number; weekday: Weekday; time: string } | null };

/** Are staff in now, and if not when do they next open? */
export function staffAvailability(now: Date, hours: BusinessHours): Availability {
  const local = localTime(now, hours.timezone);
  const today = hours.days[local.weekday] ?? [];
  if (today.some((w) => local.minutes >= toMinutes(w.open) && local.minutes < toMinutes(w.close))) {
    return { open: true };
  }
  for (let offset = 0; offset <= 7; offset++) {
    const idx = (WEEKDAYS.indexOf(local.weekday) + offset) % 7;
    const weekday = WEEKDAYS[idx] as Weekday;
    const windows = [...(hours.days[weekday] ?? [])].sort((a, b) => a.open.localeCompare(b.open));
    const win = windows.find((w) => offset > 0 || toMinutes(w.open) > local.minutes);
    if (win) return { open: false, next: { dayOffset: offset, weekday, time: win.open } };
  }
  return { open: false, next: null };
}
