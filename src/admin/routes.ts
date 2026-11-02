/**
 * Admin web UI, mounted at /admin by buildServer (server-rendered HTML, no frontend build).
 * Single admin user (ADMIN_PASSWORD); without it every /admin URL answers 503 (fail closed).
 * See src/admin/auth.ts for the session / CSRF / rate-limit design and docs/admin-ui.md for the routes.
 */
import type { OneEpcCheck } from "../oneepc/routing.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/pool.js";
import { importStockFile, type ImportStockOptions, type ImportStockResult } from "../inventory/import.js";
import { maskPhone, shopConfigSchema, WEEKDAYS, type ShopConfig } from "../bot/shop-config.js";
import { AdminInputError, addStaff, removeStaff, type RawConfig } from "./shop-admin.js";
import {
  ANON_TTL_MS, LoginRateLimiter, SESSION_COOKIE, SESSION_TTL_MS, SessionSigner, clearSessionCookieHeader, passwordMatches,
  readCookie, sessionCookieHeader, type Session,
} from "./auth.js";
import { CSS, bidi, html, layout, raw, riyadhTime, type Raw } from "./html.js";
import { SETTINGS_FIELDS, applySettingsForm, diffConfig, formValuesFromRaw, type FieldErrors, type FormValues } from "./settings-form.js";

export interface AppStatusInfo {
  dryRun: boolean;
  oneepcBaseUrl: string;
  /** Per-endpoint source (real | mock). Optional for older tests. */
  oneepcSources?: { decode: "real" | "mock"; search: "real" | "mock" };
  oneepcMockBaseUrl?: string | null;
  zernioWebhookConfigured: boolean;
  zernioApiKeyConfigured: boolean;
  version: string;
  commit: string;
  queueName: string;
}

export interface AdminDeps {
  db: Db;
  /** ADMIN_PASSWORD. Unset/empty = /admin answers 503. */
  password: string | undefined;
  status: AppStatusInfo;
  signer?: SessionSigner;
  limiter?: LoginRateLimiter;
  /** Injectable for tests. */
  importFile?: (db: Db, opts: ImportStockOptions) => Promise<ImportStockResult>;
  /** OneEPC reachability probe; default: GET <base> with a 3 s timeout, any HTTP answer = reachable. */
  probe?: (url: string) => Promise<string>;
  /** GET /status on the real API (with the key) and on the mock. When set, replaces the bare reachability probe. */
  oneepcCheck?: () => Promise<{ real: OneEpcCheck; mock: OneEpcCheck | null }>;
  maxUploadBytes?: number;
}

interface ShopRow {
  id: string; name: string; city: string | null; zernio_account_id: string | null; waba_id: string | null;
  plan: string; status: string; config: RawConfig; created_at: Date; updated_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLASH: Record<string, { kind: "ok" | "error"; text: string }> = {
  created: { kind: "ok", text: "Shop created." },
  saved: { kind: "ok", text: "Settings saved." },
  details: { kind: "ok", text: "Shop details saved." },
  staffAdded: { kind: "ok", text: "Staff member added." },
  staffRemoved: { kind: "ok", text: "Staff member removed." },
  imported: { kind: "ok", text: "Stock imported." },
};

async function defaultProbe(url: string): Promise<string> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return `reachable (HTTP ${r.status})`;
  } catch (e) {
    return `NOT reachable (${(e as Error).name})`;
  }
}

export const adminRoutes = (deps: AdminDeps): FastifyPluginAsync => async (app: FastifyInstance) => {
  const signer = deps.signer ?? new SessionSigner();
  const limiter = deps.limiter ?? new LoginRateLimiter();
  const importFile = deps.importFile ?? ((db, o) => importStockFile(db, o));
  const probe = deps.probe ?? defaultProbe;
  const sessions = new WeakMap<FastifyRequest, Session>();
  const enabled = typeof deps.password === "string" && deps.password.length > 0;

  await app.register(formbody, { bodyLimit: 64 * 1024 });
  await app.register(multipart, { limits: { fileSize: deps.maxUploadBytes ?? 50 * 1024 * 1024, files: 1, fields: 10, parts: 12 } });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    return payload;
  });

  // Fail closed: no password configured -> nothing under /admin works.
  app.addHook("onRequest", async (req, reply) => {
    if (!enabled) return reply.code(503).type("text/plain").send("Admin UI disabled: ADMIN_PASSWORD is not set.");
    const s = signer.verify(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (s) sessions.set(req, s);
    else {
      const { session, cookie } = signer.issue(false);
      sessions.set(req, session);
      reply.header("Set-Cookie", sessionCookieHeader(cookie, ANON_TTL_MS));
    }
    const open = req.routeOptions.url === "/admin/login" || req.routeOptions.url === "/admin/admin.css";
    if (!open && !sessions.get(req)?.auth) {
      if (req.method === "GET") return reply.redirect("/admin/login", 303);
      return reply.code(401).type("text/plain").send("Not logged in.");
    }
  });

  // CSRF on every POST (urlencoded here; the multipart upload checks its own _csrf field).
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST" || req.isMultipart()) return;
    const token = (req.body as Record<string, unknown> | undefined)?._csrf;
    if (!signer.csrfValid(sessions.get(req) as Session, token)) return reply.code(403).type("text/plain").send("Invalid or missing CSRF token. Reload the page and try again.");
  });

  const sess = (req: FastifyRequest) => sessions.get(req) as Session;
  const csrf = (req: FastifyRequest) => signer.csrfToken(sess(req));
  const csrfField = (req: FastifyRequest) => html`<input type="hidden" name="_csrf" value="${csrf(req)}">`;
  const clientKey = (req: FastifyRequest) => {
    const cf = req.headers["cf-connecting-ip"];
    return (typeof cf === "string" && cf.length < 64 ? cf : req.ip) ?? "unknown";
  };
  const actor = (req: FastifyRequest) => `admin@${clientKey(req)}`;
  const page = (reply: FastifyReply, req: FastifyRequest, title: string, body: Raw, flash?: { kind: "ok" | "error"; text: string } | null, code = 200) =>
    reply.code(code).type("text/html; charset=utf-8").send(layout({ title, nav: true, csrf: csrf(req), flash }, body));
  const flashFrom = (req: FastifyRequest) => FLASH[String((req.query as Record<string, unknown>)?.ok ?? "")] ?? null;

  async function audit(req: FastifyRequest, action: string, shopId: string | null, details: Record<string, unknown> = {}): Promise<void> {
    try {
      await deps.db.query("INSERT INTO admin_audit_log (actor, action, shop_id, details) VALUES ($1, $2, $3, $4::jsonb)", [actor(req), action, shopId, JSON.stringify(details)]);
    } catch (err) {
      req.log.error({ code: (err as { code?: string }).code }, "admin audit insert failed");
    }
  }

  async function loadShop(id: string): Promise<ShopRow | null> {
    if (!UUID.test(id)) return null;
    const r = await deps.db.query<ShopRow>("SELECT * FROM shops WHERE id = $1", [id]);
    return r.rows[0] ?? null;
  }

  /** Read-modify-write of shops.config under a row lock; `change` throws AdminInputError for user errors. */
  async function updateConfig(id: string, change: (raw: RawConfig) => { raw: RawConfig }): Promise<{ before: RawConfig; after: RawConfig }> {
    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<ShopRow>("SELECT config FROM shops WHERE id = $1 FOR UPDATE", [id]);
      if (!r.rows[0]) throw new AdminInputError("shop not found");
      const before = r.rows[0].config ?? {};
      const { raw: after } = change(before);
      // Belt and braces: whatever path got here, an invalid config is never written.
      if (!shopConfigSchema.safeParse(after).success) throw new AdminInputError("the resulting configuration is invalid");
      await client.query("UPDATE shops SET config = $2, updated_at = now() WHERE id = $1", [id, after]);
      await client.query("COMMIT");
      return { before, after };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- static + auth ----------
  app.get("/admin/admin.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(CSS));
  app.get("/admin", async (_req, reply) => reply.redirect("/admin/shops", 303));
  app.get("/admin/", async (_req, reply) => reply.redirect("/admin/shops", 303));

  const loginPage = (req: FastifyRequest, reply: FastifyReply, error?: string, code = 200) =>
    reply.code(code).type("text/html; charset=utf-8").send(
      layout(
        { title: "Log in", flash: error ? { kind: "error", text: error } : null },
        html`<form method="post" action="/admin/login" class="card" autocomplete="off">${csrfField(req)}
<label for="password">Admin password</label><input type="password" id="password" name="password" required autofocus autocomplete="current-password">
<p><button>Log in</button></p></form>`,
      ),
    );

  app.get("/admin/login", async (req, reply) => {
    if (sess(req).auth) return reply.redirect("/admin/shops", 303);
    return loginPage(req, reply);
  });

  app.post("/admin/login", async (req, reply) => {
    const who = clientKey(req);
    const wait = limiter.retryAfter(who);
    if (wait > 0) {
      reply.header("Retry-After", String(wait));
      return loginPage(req, reply, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.`, 429);
    }
    const given = (req.body as Record<string, unknown>)?.password;
    if (typeof given !== "string" || given.length > 1024 || !passwordMatches(given, deps.password as string)) {
      limiter.fail(who);
      await audit(req, "login.failed", null);
      return loginPage(req, reply, "Wrong password.", 401);
    }
    limiter.succeed(who);
    const { cookie } = signer.issue(true); // fresh sid: no session fixation
    reply.header("Set-Cookie", sessionCookieHeader(cookie, SESSION_TTL_MS));
    await audit(req, "login", null);
    return reply.redirect("/admin/shops", 303);
  });

  app.post("/admin/logout", async (req, reply) => {
    await audit(req, "logout", null);
    reply.header("Set-Cookie", clearSessionCookieHeader);
    return reply.redirect("/admin/login", 303);
  });

  // ---------- shops ----------
  app.get("/admin/shops", async (req, reply) => {
    const r = await deps.db.query<ShopRow & { staff_count: number; last_import: Date | null; msgs_today: number; msgs_total: number; conversations: number }>(
      `SELECT s.*,
         CASE WHEN jsonb_typeof(s.config->'staff') = 'array' THEN jsonb_array_length(s.config->'staff') ELSE 0 END AS staff_count,
         (SELECT max(imported_at) FROM inventory_imports i WHERE i.shop_id = s.id AND i.status = 'completed') AS last_import,
         (SELECT coalesce(sum(bot_messages), 0)::int FROM usage_counters u WHERE u.shop_id = s.id AND u.period_type = 'day'
             AND u.period_start = (now() AT TIME ZONE 'Asia/Riyadh')::date) AS msgs_today,
         (SELECT coalesce(sum(bot_messages), 0)::int FROM usage_counters u WHERE u.shop_id = s.id AND u.period_type = 'day') AS msgs_total,
         (SELECT count(*)::int FROM bot_conversation_state b WHERE b.shop_id = s.id) AS conversations
       FROM shops s ORDER BY s.created_at`,
    );
    const rows = r.rows.map((s) => {
      const ok = shopConfigSchema.safeParse(s.config ?? {}).success;
      return html`<tr><td><a href="/admin/shops/${s.id}">${bidi(s.name)}</a>${s.city ? html` <span class="muted">(${bidi(s.city)})</span>` : ""}${ok ? "" : html` <span class="badge closed">config invalid</span>`}</td>
<td>${s.zernio_account_id ? html`<code>${s.zernio_account_id}</code>` : html`<span class="muted">not linked</span>`}</td>
<td><span class="badge ${s.status}">${s.status}</span></td><td>${s.staff_count}</td><td>${riyadhTime(s.last_import)}</td>
<td>${s.msgs_today} / ${s.msgs_total}</td><td>${s.conversations}</td></tr>`;
    });
    return page(reply, req, "Shops", html`<p><a href="/admin/shops/new">+ New shop</a></p>
<table><thead><tr><th>Name</th><th>Zernio account</th><th>Status</th><th>Staff</th><th>Last stock import</th><th>Bot messages today / total</th><th>Conversations</th></tr></thead>
<tbody>${rows.length ? rows : html`<tr><td colspan="7" class="muted">No shops yet.</td></tr>`}</tbody></table>
<p class="muted">Message counts come from the per-day usage counters; conversations = chats the bot currently remembers.</p>`, flashFrom(req));
  });

  const newShopForm = (req: FastifyRequest, v: Record<string, string>, errors: FieldErrors) => html`<form method="post" action="/admin/shops" class="card">${csrfField(req)}
${textField("name", "Shop name", v.name ?? "", errors, "Arabic is fine.", true)}
${textField("city", "City", v.city ?? "", errors)}
${textField("zernio_account_id", "Zernio account id", v.zernio_account_id ?? "", errors, "The WhatsApp number's Zernio accountId. Empty = not linked yet.")}
<label><input type="checkbox" name="test" value="1"${v.test ? raw(" checked") : ""}> Test shop</label>
<p><button>Create shop</button></p></form>`;

  app.get("/admin/shops/new", async (req, reply) => page(reply, req, "New shop", newShopForm(req, {}, {})));

  app.post("/admin/shops", async (req, reply) => {
    const b = strings(req.body);
    const errors = validateDetails(b, true);
    if (Object.keys(errors).length) return page(reply, req, "New shop", newShopForm(req, b, errors), { kind: "error", text: "Please fix the errors below." }, 400);
    try {
      const r = await deps.db.query<{ id: string }>(
        "INSERT INTO shops (name, city, zernio_account_id, config) VALUES ($1, $2, $3, $4) RETURNING id",
        [b.name!.trim(), b.city?.trim() || null, b.zernio_account_id?.trim() || null, b.test ? { testShop: true } : {}],
      );
      const id = (r.rows[0] as { id: string }).id;
      await audit(req, "shop.create", id, { name: b.name!.trim(), testShop: !!b.test });
      return reply.redirect(`/admin/shops/${id}?ok=created`, 303);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return page(reply, req, "New shop", newShopForm(req, b, { zernio_account_id: "another shop already uses this Zernio account" }), { kind: "error", text: "Please fix the errors below." }, 400);
      }
      throw err;
    }
  });

  async function shopPage(req: FastifyRequest, reply: FastifyReply, shop: ShopRow, opts: { form?: FormValues; errors?: FieldErrors; details?: Record<string, string>; detailErrors?: FieldErrors; staffError?: string; importError?: string; flash?: { kind: "ok" | "error"; text: string } | null; code?: number } = {}) {
    const parsed = shopConfigSchema.safeParse(shop.config ?? {});
    const effective: ShopConfig = parsed.success ? parsed.data : shopConfigSchema.parse({});
    const values = opts.form ?? formValuesFromRaw(parsed.success ? shop.config : {}, effective);
    const errors = opts.errors ?? {};
    const imports = await deps.db.query<{ source_name: string; status: string; is_synthetic: boolean; rows_total: number; rows_imported: number; rows_rejected: number; rejected_counts: Record<string, number>; error: string | null; started_at: Date; imported_at: Date | null }>(
      "SELECT source_name, status, is_synthetic, rows_total, rows_imported, rows_rejected, rejected_counts, error, started_at, imported_at FROM inventory_imports WHERE shop_id = $1 ORDER BY started_at DESC LIMIT 20",
      [shop.id],
    );
    const auditRows = await deps.db.query<{ at: Date; actor: string; action: string; details: unknown }>(
      "SELECT at, actor, action, details FROM admin_audit_log WHERE shop_id = $1 ORDER BY at DESC LIMIT 20", [shop.id]);
    const d = opts.details ?? { name: shop.name, city: shop.city ?? "", zernio_account_id: shop.zernio_account_id ?? "", waba_id: shop.waba_id ?? "", plan: shop.plan, status: shop.status };
    const de = opts.detailErrors ?? {};

    const groups = [...new Set(SETTINGS_FIELDS.map((f) => f.group))];
    const settings = groups.map((g) => html`<h3>${g}</h3><div class="grid">${SETTINGS_FIELDS.filter((f) => f.group === g).map((f) => {
      const current = values[f.key] ?? "";
      const def = String((shopConfigSchema.parse({}) as Record<string, unknown>)[f.key]);
      const err = errors[f.key];
      let input: Raw;
      if (f.kind === "bool" || f.kind === "enum") {
        const opts2 = f.kind === "bool" ? [["true", "yes"], ["false", "no"]] : (f.options ?? []).map((o) => [o, o]);
        input = html`<select name="${f.key}" id="f-${f.key}"><option value="">default (${f.kind === "bool" ? (def === "true" ? "yes" : "no") : def})</option>${opts2.map(([v, l]) => html`<option value="${v}"${current === v ? raw(" selected") : ""}>${l}</option>`)}</select>`;
      } else {
        input = html`<input type="${f.kind === "int" ? "number" : "text"}" name="${f.key}" id="f-${f.key}" value="${current}" placeholder="default: ${def || "(empty)"}" dir="auto">`;
      }
      return html`<div class="field${err ? " bad" : ""}"><label for="f-${f.key}">${f.label} <span class="hint">${f.hint}</span></label>${input}${err ? html`<div class="err">${err}</div>` : ""}</div>`;
    })}</div>`);
    const hoursMode = values.hoursMode ?? "default";
    const hours = html`<h3>Opening hours (Asia/Riyadh)</h3>
<div class="field${errors.hoursMode ? " bad" : ""}"><select name="hoursMode"><option value="default"${hoursMode === "default" ? raw(" selected") : ""}>default hours</option><option value="custom"${hoursMode === "custom" ? raw(" selected") : ""}>custom hours (below)</option></select>${errors.hoursMode ? html`<div class="err">${errors.hoursMode}</div>` : ""}</div>
<p class="hint">Per day: <code>HH:MM-HH:MM</code>, comma-separated for split shifts (e.g. <code>08:00-12:00,16:00-23:00</code>), or <code>closed</code>. A close time before the open time runs past midnight.</p>
<div class="grid">${WEEKDAYS.map((day) => html`<div class="field${errors[`hours.${day}`] ? " bad" : ""}"><label for="h-${day}">${day}</label><input type="text" id="h-${day}" name="hours.${day}" value="${values[`hours.${day}`] ?? ""}">${errors[`hours.${day}`] ? html`<div class="err">${errors[`hours.${day}`]}</div>` : ""}</div>`)}</div>`;

    const staffRows = effective.staff.map((s) => html`<tr><td>${bidi(s.name)}</td><td><code>${maskPhone(s.phone)}</code></td><td>${s.notify ? "yes" : "no"}</td>
<td><form method="post" action="/admin/shops/${shop.id}/staff/remove" class="inline">${csrfField(req)}<input type="hidden" name="name" value="${s.name}"><button class="danger">Remove</button></form></td></tr>`);

    const importRows = imports.rows.map((i) => html`<tr><td>${riyadhTime(i.imported_at ?? i.started_at)}</td><td>${bidi(i.source_name)}${i.is_synthetic ? html` <span class="badge">synthetic</span>` : ""}</td>
<td><span class="badge ${i.status === "completed" ? "active" : i.status === "failed" ? "closed" : "paused"}">${i.status}</span></td><td>${i.rows_total}</td><td>${i.rows_imported}</td>
<td>${i.rows_rejected}${Object.keys(i.rejected_counts ?? {}).length ? html` <span class="muted">(${Object.entries(i.rejected_counts).map(([k, n]) => `${k}: ${n}`).join(", ")})</span>` : ""}${i.error ? html`<div class="err">${i.error}</div>` : ""}</td></tr>`);

    const body = html`
${parsed.success ? "" : html`<p class="flash error">The stored configuration is INVALID, so the bot does not reply for this shop. Saving the settings form below replaces it with a valid one.</p>`}
<h2>Shop details</h2>
<form method="post" action="/admin/shops/${shop.id}/details" class="card">${csrfField(req)}<div class="grid">
${textField("name", "Shop name", d.name ?? "", de, "", true)}${textField("city", "City", d.city ?? "", de)}
${textField("zernio_account_id", "Zernio account id", d.zernio_account_id ?? "", de, "Empty = not linked.")}${textField("waba_id", "WABA id", d.waba_id ?? "", de)}
${textField("plan", "Plan", d.plan ?? "", de)}
<div class="field${de.status ? " bad" : ""}"><label for="f-status">Status <span class="hint">paused/closed = the bot does not reply</span></label><select id="f-status" name="status">${["active", "paused", "closed"].map((s) => html`<option${d.status === s ? raw(" selected") : ""}>${s}</option>`)}</select>${de.status ? html`<div class="err">${de.status}</div>` : ""}</div>
</div><p><button>Save details</button></p></form>

<h2>Bot settings</h2>
<form method="post" action="/admin/shops/${shop.id}/settings" class="card">${csrfField(req)}
${errors._form ? html`<p class="err">${errors._form}</p>` : ""}${settings}${hours}
<p><button>Save settings</button> <span class="hint">"default" = not set for this shop (follows the app default).</span></p></form>

<h2>Staff (${effective.staff.length}/10)</h2>
<div class="card">${opts.staffError ? html`<p class="flash error">${opts.staffError}</p>` : ""}
<table><thead><tr><th>Name</th><th>WhatsApp</th><th>Notify</th><th></th></tr></thead><tbody>${staffRows.length ? staffRows : html`<tr><td colspan="4" class="muted">No staff yet.</td></tr>`}</tbody></table>
<form method="post" action="/admin/shops/${shop.id}/staff" autocomplete="off">${csrfField(req)}<div class="grid">
<div><label for="s-name">Name</label><input type="text" id="s-name" name="name" required maxlength="60" dir="auto"></div>
<div><label for="s-phone">WhatsApp number <span class="hint">05XXXXXXXX or +E164</span></label><input type="text" id="s-phone" name="phone" required maxlength="25" inputmode="tel" autocomplete="off"></div>
</div><label><input type="checkbox" name="notify" value="1" checked> Receives handoff notifications</label><p><button>Add staff</button></p></form></div>

<h2>Stock import</h2>
<div class="card">${opts.importError ? html`<p class="flash error">${opts.importError}</p>` : ""}
<form method="post" action="/admin/shops/${shop.id}/import" enctype="multipart/form-data">${csrfField(req)}
${effective.testShop ? html`<label><input type="checkbox" name="synthetic" value="1"> Fill qty/price with synthetic test values (test shop only)</label><label for="seed">Seed</label><input type="number" id="seed" name="seed" value="1" min="0">` : ""}
<label for="file">CSV / XLSX / XLSM file <span class="hint">replaces this shop's whole stock list; macros are never run; rows with personal data are skipped and counted</span></label>
<input type="file" id="file" name="file" accept=".csv,.xlsx,.xlsm" required><p><button>Import</button></p></form>
<table><thead><tr><th>When</th><th>File</th><th>Status</th><th>Rows</th><th>Accepted</th><th>Rejected</th></tr></thead><tbody>${importRows.length ? importRows : html`<tr><td colspan="6" class="muted">No imports yet.</td></tr>`}</tbody></table></div>

<h2>Recent changes</h2>
${auditTable(auditRows.rows.map((a) => ({ ...a, shop_name: null })), false)}`;
    return page(reply, req, shop.name, body, opts.flash ?? flashFrom(req), opts.code ?? 200);
  }

  app.get("/admin/shops/:id", async (req, reply) => {
    const shop = await loadShop((req.params as { id: string }).id);
    if (!shop) return page(reply, req, "Not found", html`<p>No such shop.</p>`, null, 404);
    return shopPage(req, reply, shop);
  });

  app.post("/admin/shops/:id/details", async (req, reply) => {
    const shop = await loadShop((req.params as { id: string }).id);
    if (!shop) return page(reply, req, "Not found", html`<p>No such shop.</p>`, null, 404);
    const b = strings(req.body);
    const errors = validateDetails(b, false);
    if (Object.keys(errors).length) return shopPage(req, reply, shop, { details: b, detailErrors: errors, flash: { kind: "error", text: "Shop details not saved: please fix the errors." }, code: 400 });
    const next = { name: b.name!.trim(), city: b.city?.trim() || null, zernio_account_id: b.zernio_account_id?.trim() || null, waba_id: b.waba_id?.trim() || null, plan: b.plan!.trim(), status: b.status! };
    try {
      await deps.db.query("UPDATE shops SET name = $2, city = $3, zernio_account_id = $4, waba_id = $5, plan = $6, status = $7, updated_at = now() WHERE id = $1",
        [shop.id, next.name, next.city, next.zernio_account_id, next.waba_id, next.plan, next.status]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return shopPage(req, reply, shop, { details: b, detailErrors: { zernio_account_id: "another shop already uses this Zernio account" }, flash: { kind: "error", text: "Shop details not saved." }, code: 400 });
      throw err;
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(next)) if ((shop as unknown as Record<string, unknown>)[k] !== v) changes[k] = { from: (shop as unknown as Record<string, unknown>)[k], to: v };
    await audit(req, "shop.details", shop.id, changes);
    return reply.redirect(`/admin/shops/${shop.id}?ok=details`, 303);
  });

  app.post("/admin/shops/:id/settings", async (req, reply) => {
    const shop = await loadShop((req.params as { id: string }).id);
    if (!shop) return page(reply, req, "Not found", html`<p>No such shop.</p>`, null, 404);
    const form = strings(req.body);
    const base = shopConfigSchema.safeParse(shop.config ?? {}).success ? shop.config : {}; // invalid stored config is replaced
    const result = applySettingsForm(base, form);
    if (!result.config) return shopPage(req, reply, shop, { form, errors: result.errors, flash: { kind: "error", text: "Settings not saved: please fix the highlighted fields." }, code: 400 });
    try {
      const { before, after } = await updateConfig(shop.id, (current) => {
        const valid = shopConfigSchema.safeParse(current ?? {}).success ? current : {};
        const r = applySettingsForm(valid, form); // re-applied under the row lock (concurrent staff edits are kept)
        if (!r.config) throw new AdminInputError("settings changed concurrently and are no longer valid; reload");
        return { raw: r.raw };
      });
      await audit(req, "shop.settings", shop.id, diffConfig(before, after));
    } catch (err) {
      if (err instanceof AdminInputError) return shopPage(req, reply, shop, { form, errors: { _form: err.message }, flash: { kind: "error", text: err.message }, code: 400 });
      throw err;
    }
    return reply.redirect(`/admin/shops/${shop.id}?ok=saved`, 303);
  });

  app.post("/admin/shops/:id/staff", async (req, reply) => {
    const shop = await loadShop((req.params as { id: string }).id);
    if (!shop) return page(reply, req, "Not found", html`<p>No such shop.</p>`, null, 404);
    const b = strings(req.body);
    let masked = "";
    try {
      await updateConfig(shop.id, (current) => {
        const r = addStaff(current, { name: b.name ?? "", phone: b.phone ?? "", notify: b.notify === "1" });
        masked = maskPhone(r.config.staff[r.config.staff.length - 1]!.phone);
        return r;
      });
    } catch (err) {
      if (err instanceof AdminInputError) return shopPage(req, reply, shop, { staffError: err.message, code: 400 });
      throw err;
    }
    await audit(req, "staff.add", shop.id, { name: (b.name ?? "").trim(), phone: masked, notify: b.notify === "1" });
    return reply.redirect(`/admin/shops/${shop.id}?ok=staffAdded`, 303);
  });

  app.post("/admin/shops/:id/staff/remove", async (req, reply) => {
    const shop = await loadShop((req.params as { id: string }).id);
    if (!shop) return page(reply, req, "Not found", html`<p>No such shop.</p>`, null, 404);
    const b = strings(req.body);
    try {
      await updateConfig(shop.id, (current) => removeStaff(current, b.name ?? ""));
    } catch (err) {
      if (err instanceof AdminInputError) return shopPage(req, reply, shop, { staffError: err.message, code: 400 });
      throw err;
    }
    await audit(req, "staff.remove", shop.id, { name: (b.name ?? "").trim() });
    return reply.redirect(`/admin/shops/${shop.id}?ok=staffRemoved`, 303);
  });

  app.post("/admin/shops/:id/import", async (req, reply) => {
    const shop = await loadShop((req.params as { id: string }).id);
    if (!shop) return page(reply, req, "Not found", html`<p>No such shop.</p>`, null, 404);
    if (!req.isMultipart()) return reply.code(400).type("text/plain").send("Expected a file upload.");
    const fields: Record<string, string> = {};
    let dir: string | null = null;
    let file: string | null = null;
    let originalName = "";
    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value ?? "");
          continue;
        }
        // The CSRF field comes before the file in the form; refuse to even store a file without it.
        if (!signer.csrfValid(sess(req), fields._csrf)) {
          part.file.resume();
          return reply.code(403).type("text/plain").send("Invalid or missing CSRF token. Reload the page and try again.");
        }
        originalName = path.basename(part.filename || "upload").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "upload";
        const ext = path.extname(originalName).toLowerCase();
        if (![".csv", ".xlsx", ".xlsm"].includes(ext)) {
          part.file.resume();
          return shopPage(req, reply, shop, { importError: "Use a .csv, .xlsx or .xlsm file.", code: 400 });
        }
        dir = await mkdtemp(path.join(tmpdir(), "partsbot-upload-"));
        file = path.join(dir, originalName);
        await writeFile(file, await part.toBuffer(), { mode: 0o600 });
      }
      if (!signer.csrfValid(sess(req), fields._csrf)) return reply.code(403).type("text/plain").send("Invalid or missing CSRF token. Reload the page and try again.");
      if (!file) return shopPage(req, reply, shop, { importError: "Choose a file to import.", code: 400 });
      let synthetic: { seed: number } | null = null;
      if (fields.synthetic === "1") {
        if (!shopConfigSchema.safeParse(shop.config ?? {}).data?.testShop) return shopPage(req, reply, shop, { importError: "Synthetic stock is only for test shops.", code: 400 });
        const seed = Number(fields.seed ?? "1");
        if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1) return shopPage(req, reply, shop, { importError: "Seed must be a non-negative whole number.", code: 400 });
        synthetic = { seed };
      }
      try {
        const res = await importFile(deps.db, { shopId: shop.id, file, synthetic });
        await audit(req, "stock.import", shop.id, { file: originalName, rowsTotal: res.parsed.rowsTotal, accepted: res.outcome?.rowsImported ?? 0, rejected: res.parsed.rowsRejected, synthetic: synthetic !== null });
      } catch (err) {
        await audit(req, "stock.import.failed", shop.id, { file: originalName, error: (err as Error).name });
        return shopPage(req, reply, shop, { importError: `Import failed: ${String((err as Error).message ?? "").slice(0, 200)}`, code: 400 });
      }
      return reply.redirect(`/admin/shops/${shop.id}?ok=imported`, 303);
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return shopPage(req, reply, shop, { importError: "File too large.", code: 413 });
      throw err;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  // ---------- app status + audit ----------
  app.get("/admin/app", async (req, reply) => {
    const s = deps.status;
    let dbState = "up";
    let queue: Raw = html`<span class="muted">unavailable</span>`;
    try {
      await deps.db.query("SELECT 1");
      try {
        const q = await deps.db.query<{ state: string; n: number }>(
          "SELECT state::text AS state, count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry', 'active') GROUP BY 1", [s.queueName]);
        const by = Object.fromEntries(q.rows.map((r) => [r.state, r.n]));
        queue = html`${(by.created ?? 0) + (by.retry ?? 0)} waiting (${by.retry ?? 0} retrying), ${by.active ?? 0} in progress`;
      } catch {
        /* pg-boss schema not created yet */
      }
    } catch {
      dbState = "DOWN";
    }
    const yes = (b: boolean) => (b ? "yes" : "no");
    let oneepcRows: Raw;
    if (deps.oneepcCheck) {
      const c = await deps.oneepcCheck().catch((): { real: OneEpcCheck; mock: OneEpcCheck | null } => ({ real: { state: "error", detail: "check failed" }, mock: null }));
      const src = s.oneepcSources ?? { decode: "real", search: "real" };
      const route = (e: "decode" | "search") =>
        src[e] === "real" ? html`real API` : html`<strong>mock</strong> <span class="hint">test shops only; real shops get a staff handoff, never mock data</span>`;
      oneepcRows = html`<tr><th>OneEPC status</th><td>${checkLabel(c.real)}</td></tr>
<tr><th>OneEPC API key</th><td>${c.real.state === "not_configured" ? "not configured" : c.real.state === "auth_failed" ? "configured, REJECTED by OneEPC" : c.real.state === "ok" ? "configured, accepted" : "configured (not verified)"}</td></tr>
<tr><th>OneEPC endpoints</th><td>status: real API · VIN decode: ${route("decode")} · parts search: ${route("search")}</td></tr>
${s.oneepcMockBaseUrl ? html`<tr><th>Mock OneEPC</th><td><code>${s.oneepcMockBaseUrl}</code> · ${c.mock ? checkLabel(c.mock) : "not checked"}</td></tr>` : ""}`;
    } else {
      oneepcRows = html`<tr><th>OneEPC reachability</th><td>${await probe(s.oneepcBaseUrl)}</td></tr>`;
    }
    return page(reply, req, "App status", html`<table><tbody>
<tr><th>DRY_RUN</th><td>${s.dryRun ? "ON (the bot logs replies and sends nothing)" : "off (replies are sent)"} <span class="hint">as set in the server's environment; the worker is started with the same settings</span></td></tr>
<tr><th>OneEPC base URL</th><td><code>${s.oneepcBaseUrl}</code></td></tr>
${oneepcRows}
<tr><th>Zernio webhook secret configured</th><td>${yes(s.zernioWebhookConfigured)}</td></tr>
<tr><th>Zernio API key configured</th><td>${yes(s.zernioApiKeyConfigured)}</td></tr>
<tr><th>Database</th><td>${dbState}</td></tr>
<tr><th>Inbound queue (${s.queueName})</th><td>${queue}</td></tr>
<tr><th>Version</th><td>${s.version} · commit <code>${s.commit}</code></td></tr>
<tr><th>Page generated</th><td>${riyadhTime(new Date())}</td></tr>
</tbody></table><p class="muted">Read-only. Secrets are shown only as configured yes/no.</p>`);
  });

  app.get("/admin/audit", async (req, reply) => {
    const r = await deps.db.query<{ at: Date; actor: string; action: string; details: unknown; shop_name: string | null }>(
      "SELECT a.at, a.actor, a.action, a.details, s.name AS shop_name FROM admin_audit_log a LEFT JOIN shops s ON s.id = a.shop_id ORDER BY a.at DESC LIMIT 200");
    return page(reply, req, "Audit log", html`${auditTable(r.rows, true)}<p class="muted">Latest 200 entries. Times in Asia/Riyadh.</p>`);
  });
};

function checkLabel(c: OneEpcCheck): Raw {
  const word = { ok: "OK", auth_failed: "AUTH FAILED", not_configured: "not configured", unreachable: "NOT reachable", error: "ERROR" }[c.state];
  return html`<strong>${word}</strong> <span class="hint">${c.detail}</span>`;
}

function auditTable(rows: { at: Date; actor: string; action: string; details: unknown; shop_name: string | null }[], withShop: boolean): Raw {
  if (!rows.length) return html`<p class="muted">Nothing yet.</p>`;
  return html`<table><thead><tr><th>When</th><th>Who</th><th>Action</th>${withShop ? html`<th>Shop</th>` : ""}<th>Details</th></tr></thead><tbody>${rows.map(
    (a) => html`<tr><td>${riyadhTime(a.at)}</td><td>${a.actor}</td><td><code>${a.action}</code></td>${withShop ? html`<td>${a.shop_name ? bidi(a.shop_name) : "—"}</td>` : ""}<td><code dir="auto">${JSON.stringify(a.details ?? {})}</code></td></tr>`,
  )}</tbody></table>`;
}

function textField(name: string, label: string, value: string, errors: FieldErrors, hint = "", required = false): Raw {
  const err = errors[name];
  return html`<div class="field${err ? " bad" : ""}"><label for="f-${name}">${label}${hint ? html` <span class="hint">${hint}</span>` : ""}</label><input type="text" id="f-${name}" name="${name}" value="${value}" dir="auto"${required ? raw(" required") : ""}>${err ? html`<div class="err">${err}</div>` : ""}</div>`;
}

/** Form body -> string fields only (arrays/objects dropped). */
function strings(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((body as Record<string, unknown>) ?? {})) if (typeof v === "string" && k !== "_csrf") out[k] = v;
  return out;
}

function validateDetails(b: Record<string, string>, creating: boolean): FieldErrors {
  const e: FieldErrors = {};
  const name = (b.name ?? "").trim();
  if (!name) e.name = "required";
  else if (name.length > 120) e.name = "at most 120 characters";
  if ((b.city ?? "").trim().length > 80) e.city = "at most 80 characters";
  const acct = (b.zernio_account_id ?? "").trim();
  if (acct && !/^[A-Za-z0-9_-]{1,64}$/.test(acct)) e.zernio_account_id = "letters, digits, - and _ only";
  const waba = (b.waba_id ?? "").trim();
  if (waba && !/^[A-Za-z0-9_-]{1,64}$/.test(waba)) e.waba_id = "letters, digits, - and _ only";
  if (!creating) {
    if (!/^[a-z0-9_-]{1,40}$/.test((b.plan ?? "").trim())) e.plan = "lowercase letters, digits, - and _ (e.g. starter)";
    if (!["active", "paused", "closed"].includes(b.status ?? "")) e.status = "choose active, paused or closed";
  }
  return e;
}
