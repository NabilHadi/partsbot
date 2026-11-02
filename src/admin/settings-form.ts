/**
 * The shop settings form of the admin UI: field metadata, form -> stored config, and inline errors.
 * Validation is the SAME zod schema the CLI and the bot use (shopConfigSchema); an invalid result is never saved.
 * As in the CLI, only explicitly chosen keys are stored ("default" = key removed, so improved defaults reach the shop).
 */
import { AdminInputError, parseWindows, type RawConfig } from "./shop-admin.js";
import { AFTER_HOURS_MODES, AI_PROVIDER_CHOICES, STOCK_DISPLAY, WEEKDAYS, shopConfigSchema, type ShopConfig } from "../bot/shop-config.js";

export type FieldKind = "bool" | "enum" | "text" | "int";
export interface FieldDef {
  key: keyof ShopConfig & string;
  kind: FieldKind;
  label: string;
  hint: string;
  options?: readonly string[];
  group: "Customer-facing replies" | "Hours and handoff" | "Stock data" | "Limits";
}

export const SETTINGS_FIELDS: FieldDef[] = [
  { key: "showPartNumbers", kind: "bool", label: "Show part numbers", hint: "Off: the part is named only; the number is still logged for staff.", group: "Customer-facing replies" },
  { key: "stockDisplay", kind: "enum", options: STOCK_DISPLAY, label: "Stock display", hint: "hidden / availability (in stock or not) / quantity (exact count).", group: "Customer-facing replies" },
  { key: "showAlternatives", kind: "bool", label: "Show alternative parts", hint: "Variants of the same base number (CH, J, DENSO...).", group: "Customer-facing replies" },
  { key: "priceQuotingEnabled", kind: "bool", label: "Show prices", hint: "Show the shop's price next to stock lines.", group: "Customer-facing replies" },
  { key: "aiEnabled", kind: "bool", label: "AI assistant", hint: "AI understands messages and words replies. Part numbers still come only from OneEPC; needs AI_ENABLED on the server.", group: "Customer-facing replies" },
  { key: "aiProvider", kind: "enum", options: AI_PROVIDER_CHOICES, label: "AI provider", hint: "server_default = AI_PROVIDER on the server. A provider with no API key on the server falls back to the default.", group: "Customer-facing replies" },
  { key: "language", kind: "enum", options: ["ar", "en", "auto"], label: "Reply language", hint: "auto = the script of the customer's last message.", group: "Customer-facing replies" },
  { key: "shopName", kind: "text", label: "Shop name in the welcome line", hint: "Empty = omitted.", group: "Customer-facing replies" },
  { key: "afterHoursMode", kind: "enum", options: AFTER_HOURS_MODES, label: "After hours", hint: "reply_with_note = answer + one 'closed now' note; note_only = only the note.", group: "Hours and handoff" },
  { key: "staffHandoffName", kind: "text", label: "Staff name told to customers", hint: "Empty = \"الموظف\".", group: "Hours and handoff" },
  { key: "staffHandoffPhone", kind: "text", label: "Public shop phone for handoff replies", hint: "A PUBLIC shop line, never a personal number.", group: "Hours and handoff" },
  { key: "testShop", kind: "bool", label: "Test shop", hint: "Only a test shop may ever see synthetic stock.", group: "Stock data" },
  { key: "allowSyntheticStock", kind: "bool", label: "Use synthetic stock", hint: "No effect unless Test shop is on.", group: "Stock data" },
  { key: "stockStaleDays", kind: "int", label: "Stock stale after (days)", hint: "Older stock lists show the date and 'staff confirm', no quantities.", group: "Stock data" },
  { key: "maxPartsPerReply", kind: "int", label: "Max parts per reply", hint: "1-10.", group: "Limits" },
  { key: "maxBotMessagesPerDay", kind: "int", label: "Max bot messages per day", hint: "Per shop daily cap.", group: "Limits" },
  { key: "sessionTtlMinutes", kind: "int", label: "Conversation memory (minutes)", hint: "How long the vehicle is remembered.", group: "Limits" },
  { key: "handoffSilenceMinutes", kind: "int", label: "Silence after handoff (minutes)", hint: "The bot stays quiet while staff handle the chat.", group: "Limits" },
];

/** Keys with their own UI (not plain fields). */
export const SPECIAL_KEYS = ["businessHours", "staff"] as const;

export type FormValues = Record<string, string>;
export type FieldErrors = Record<string, string>;

/** Current stored values as form strings ("" = default). */
export function formValuesFromRaw(raw: RawConfig, effective: ShopConfig): FormValues {
  const v: FormValues = {};
  for (const f of SETTINGS_FIELDS) v[f.key] = f.key in raw ? String(raw[f.key]) : "";
  v.hoursMode = raw.businessHours ? "custom" : "default";
  for (const d of WEEKDAYS) v[`hours.${d}`] = windowsSpec(effective.businessHours.days[d] ?? []);
  return v;
}

export function windowsSpec(w: { open: string; close: string }[]): string {
  return w.length ? w.map((x) => `${x.open}-${x.close}`).join(",") : "closed";
}

/** Form -> next stored config. Never throws: errors come back per field (messages only, never values). */
export function applySettingsForm(current: RawConfig, form: FormValues): { raw: RawConfig; config?: ShopConfig; errors: FieldErrors } {
  const next: RawConfig = structuredClone(current ?? {});
  const errors: FieldErrors = {};
  for (const f of SETTINGS_FIELDS) {
    const s = (form[f.key] ?? "").trim();
    if (s === "") {
      delete next[f.key];
      continue;
    }
    if (f.kind === "bool") {
      if (s !== "true" && s !== "false") errors[f.key] = "choose default, yes or no";
      else next[f.key] = s === "true";
    } else if (f.kind === "int") {
      if (!/^-?\d+$/.test(s)) errors[f.key] = "must be a whole number";
      else next[f.key] = Number(s);
    } else if (f.kind === "enum") {
      if (!f.options?.includes(s)) errors[f.key] = `choose one of: ${f.options?.join(", ")}`;
      else next[f.key] = s;
    } else {
      next[f.key] = s;
    }
  }
  if ((form.hoursMode ?? "default") === "default") delete next.businessHours;
  else {
    const days: Record<string, unknown> = {};
    for (const d of WEEKDAYS) {
      try {
        days[d] = parseWindows(form[`hours.${d}`] ?? "closed");
      } catch (e) {
        errors[`hours.${d}`] = e instanceof AdminInputError ? e.message : "invalid hours";
      }
    }
    next.businessHours = { timezone: "Asia/Riyadh", days };
  }
  if (Object.keys(errors).length) return { raw: next, errors };
  const r = shopConfigSchema.safeParse(next);
  if (!r.success) {
    for (const i of r.error.issues) {
      const [top, , day] = i.path.map(String);
      const k = top === "businessHours" ? (day && WEEKDAYS.includes(day as never) ? `hours.${day}` : "hoursMode") : (top ?? "_form");
      errors[k] = errors[k] ? `${errors[k]}; ${i.message}` : i.message;
    }
    return { raw: next, errors };
  }
  return { raw: next, config: r.data, errors };
}

/** Changed top-level keys (staff excluded: audited separately, masked). */
export function diffConfig(before: RawConfig, after: RawConfig): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (k === "staff") continue;
    const a = JSON.stringify(before?.[k] ?? null);
    const b = JSON.stringify(after?.[k] ?? null);
    if (a !== b) out[k] = { from: before?.[k] ?? "(default)", to: after?.[k] ?? "(default)" };
  }
  return out;
}
