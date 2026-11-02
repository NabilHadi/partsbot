/**
 * Pure helpers behind `npm run shop` (src/scripts/shop.ts): parse `key=value` edits, apply them to a shop's
 * stored config, and render a config for display with staff numbers masked. No database here (unit-tested).
 *
 * The stored config keeps ONLY the keys a shop set explicitly (defaults stay in code, so improving a default
 * reaches every shop that did not choose otherwise). Every change is validated with the full schema first.
 */
import { WEEKDAYS, maskPhone, normalizeWhatsAppNumber, parseShopConfig, shopConfigSchema, type ShopConfig, type Weekday } from "../bot/shop-config.js";

export type RawConfig = Record<string, unknown>;

export class AdminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminInputError";
  }
}

/** Top-level settings `set` may change. `staff` has its own commands (they normalize numbers); `businessHours` via `hours.<day>`. */
const SETTABLE = new Set(Object.keys(shopConfigSchema.shape).filter((k) => k !== "staff" && k !== "businessHours"));

/** "08:00-12:00,16:00-23:00" -> windows; "closed" or "" -> []. */
export function parseWindows(spec: string): { open: string; close: string }[] {
  const s = spec.trim().toLowerCase();
  if (s === "closed" || s === "" || s === "-") return [];
  return s.split(",").map((part) => {
    const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(part);
    if (!m) throw new AdminInputError(`bad hours "${part}" (use HH:MM-HH:MM, comma-separated, or "closed")`);
    const pad = (t: string) => t.padStart(5, "0");
    return { open: pad(m[1] as string), close: pad(m[2] as string) };
  });
}

/** CLI value -> JSON value: true/false, numbers, JSON literals; anything else is a string. */
function parseValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{"]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      throw new AdminInputError(`value is not valid JSON: ${v.slice(0, 40)}`);
    }
  }
  return v;
}

export interface Assignment { key: string; value: unknown }

export function parseAssignments(args: string[]): Assignment[] {
  if (args.length === 0) throw new AdminInputError("nothing to set (use key=value)");
  return args.map((a) => {
    const i = a.indexOf("=");
    if (i <= 0) throw new AdminInputError(`expected key=value, got "${a}"`);
    const key = a.slice(0, i).trim();
    const raw = a.slice(i + 1);
    if (key.startsWith("hours.")) return { key, value: parseWindows(raw) };
    return { key, value: parseValue(raw) };
  });
}

function hoursDay(key: string): Weekday {
  const day = key.slice("hours.".length) as Weekday;
  if (!WEEKDAYS.includes(day)) throw new AdminInputError(`unknown day "${day}" (use ${WEEKDAYS.join("/")})`);
  return day;
}

/** Explicit business hours, starting from the default hours the first time a shop edits a day. */
function explicitHours(raw: RawConfig): { timezone: "Asia/Riyadh"; days: Record<string, unknown> } {
  const current = parseShopConfig(raw).businessHours;
  return { timezone: current.timezone, days: { ...current.days } };
}

/** Apply edits; throws AdminInputError (with zod's messages) when the result is not a valid config. */
export function applySet(raw: RawConfig, edits: Assignment[]): { raw: RawConfig; config: ShopConfig } {
  const next: RawConfig = structuredClone(raw ?? {});
  for (const { key, value } of edits) {
    if (key.startsWith("hours.")) {
      const day = hoursDay(key);
      const hours = (next.businessHours as ReturnType<typeof explicitHours> | undefined) ?? explicitHours(next);
      hours.days[day] = value;
      next.businessHours = hours;
    } else if (key === "staff") {
      throw new AdminInputError("use staff-add / staff-remove for staff");
    } else if (!SETTABLE.has(key)) {
      throw new AdminInputError(`unknown setting "${key}"`);
    } else {
      next[key] = value;
    }
  }
  return { raw: next, config: validate(next) };
}

export function applyUnset(raw: RawConfig, keys: string[]): { raw: RawConfig; config: ShopConfig } {
  const next: RawConfig = structuredClone(raw ?? {});
  for (const key of keys) {
    if (key === "hours") delete next.businessHours;
    else if (key.startsWith("hours.")) {
      const hours = (next.businessHours as ReturnType<typeof explicitHours> | undefined) ?? explicitHours(next);
      delete hours.days[hoursDay(key)];
      next.businessHours = hours;
    } else if (key in shopConfigSchema.shape) delete next[key];
    else throw new AdminInputError(`unknown setting "${key}"`);
  }
  return { raw: next, config: validate(next) };
}

function validate(raw: RawConfig): ShopConfig {
  const r = shopConfigSchema.safeParse(raw);
  if (!r.success) {
    // Messages and paths only: never echo values (they could be a phone number).
    throw new AdminInputError(`invalid config: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

export function addStaff(raw: RawConfig, member: { name: string; phone: string; notify?: boolean }): { raw: RawConfig; config: ShopConfig } {
  const e164 = normalizeWhatsAppNumber(member.phone);
  if (!e164) throw new AdminInputError("phone is not a valid WhatsApp mobile number (e.g. 05XXXXXXXX or +9665XXXXXXXX)");
  const name = member.name.trim();
  const staff = [...((raw.staff as unknown[] | undefined) ?? [])] as { name: string }[];
  if (staff.some((s) => s.name === name)) throw new AdminInputError(`staff "${name}" already exists (staff-remove first)`);
  staff.push({ name, phone: e164, notify: member.notify ?? true } as never);
  const next = { ...raw, staff };
  return { raw: next, config: validate(next) };
}

export function removeStaff(raw: RawConfig, name: string): { raw: RawConfig; config: ShopConfig } {
  const staff = ((raw.staff as { name: string }[] | undefined) ?? []);
  if (!staff.some((s) => s.name === name.trim())) throw new AdminInputError(`no staff named "${name}"`);
  const next = { ...raw, staff: staff.filter((s) => s.name !== name.trim()) };
  return { raw: next, config: validate(next) };
}

/** The effective config for display: staff numbers masked (last 4 digits); `*` marks keys the shop set. */
export function renderConfig(raw: RawConfig, config: ShopConfig): string[] {
  const out: string[] = [];
  const explicit = (k: string) => (k in (raw ?? {}) ? "*" : " ");
  for (const [k, v] of Object.entries(config)) {
    if (k === "businessHours" || k === "staff") continue;
    out.push(`${explicit(k)} ${k.padEnd(22)} ${JSON.stringify(v)}`);
  }
  out.push(`${explicit("businessHours")} businessHours (${config.businessHours.timezone})`);
  for (const d of ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const) {
    const w = config.businessHours.days[d] ?? [];
    out.push(`    ${d}  ${w.length ? w.map((x) => `${x.open}-${x.close}${x.close <= x.open ? " (+1 day)" : ""}`).join(", ") : "closed"}`);
  }
  out.push(`${explicit("staff")} staff (${config.staff.length})`);
  for (const s of config.staff) out.push(`    ${s.name}  ${maskPhone(s.phone)}${s.notify ? "" : "  (no notifications)"}`);
  out.push("(* = set for this shop; others are defaults)");
  return out;
}
