// /admin against real Postgres: set TEST_DATABASE_URL to a throwaway database (migrations are applied here).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { buildServer } from "../server.js";
import { loadActiveSynonyms, recordSuggestion } from "../ai/synonym-repo.js";
import { SynonymIndex } from "../ai/synonyms.js";

const TEST_DB = process.env.TEST_DATABASE_URL;
const PW = "db-test-admin-password";

describe.skipIf(!TEST_DB)("/admin with real Postgres", () => {
  let db: Db;
  let a: ReturnType<typeof buildServer>;
  let cookie = "";
  let csrf = "";
  const shopIds: string[] = [];
  const form = (o: Record<string, string>) => new URLSearchParams({ _csrf: csrf, ...o }).toString();
  const post = (url: string, o: Record<string, string>) =>
    a.inject({ method: "POST", url, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: form(o) });
  const get = (url: string) => a.inject({ method: "GET", url, headers: { cookie } });

  beforeAll(async () => {
    db = createPool(TEST_DB as string);
    await migrate(db);
    a = buildServer({ logger: false, admin: { db, password: PW, status: { dryRun: false, oneepcBaseUrl: "http://127.0.0.1:9/api", zernioWebhookConfigured: false, zernioApiKeyConfigured: false, version: "t", commit: "t", queueName: "inbound-message" }, probe: async () => "skipped" } });
    const lp = await a.inject({ method: "GET", url: "/admin/login" });
    const anon = String(lp.headers["set-cookie"]).split(";")[0] as string;
    const anonCsrf = /name="_csrf" value="([^"]+)"/.exec(lp.body)?.[1] as string;
    const res = await a.inject({ method: "POST", url: "/admin/login", headers: { cookie: anon, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ _csrf: anonCsrf, password: PW }).toString() });
    cookie = String(res.headers["set-cookie"]).split(";")[0] as string;
    csrf = /name="_csrf" value="([^"]+)"/.exec((await get("/admin/shops")).body)?.[1] as string;
  });

  afterAll(async () => {
    if (db) {
      for (const id of shopIds) await db.query("DELETE FROM shops WHERE id = $1", [id]);
      await db.end();
    }
  });

  it("create shop (validation inline), edit settings, staff, import, audit", async () => {
    const bad = await post("/admin/shops", { name: "", city: "", zernio_account_id: "" });
    expect(bad.statusCode).toBe(400);

    const created = await post("/admin/shops", { name: "قطع غيار <script>x</script> (fake)", city: "الرياض", zernio_account_id: "", test: "1" });
    expect(created.statusCode).toBe(303);
    const id = /\/admin\/shops\/([0-9a-f-]{36})/.exec(String(created.headers.location))?.[1] as string;
    shopIds.push(id);

    const list = await get("/admin/shops");
    expect(list.body).toContain("&lt;script&gt;");
    expect(list.body).not.toContain("<script>x");
    expect(list.body).toContain('<bdi dir="auto">');

    // Invalid settings are refused and nothing is written.
    const before = (await db.query("SELECT config FROM shops WHERE id = $1", [id])).rows[0].config;
    const inv = await post(`/admin/shops/${id}/settings`, { maxPartsPerReply: "99", hoursMode: "default" });
    expect(inv.statusCode).toBe(400);
    expect(inv.body).toContain('class="err"');
    expect((await db.query("SELECT config FROM shops WHERE id = $1", [id])).rows[0].config).toEqual(before);

    const ok = await post(`/admin/shops/${id}/settings`, { testShop: "true", maxPartsPerReply: "2", stockDisplay: "quantity", hoursMode: "custom", "hours.sun": "08:00-12:00", "hours.mon": "closed", "hours.tue": "closed", "hours.wed": "closed", "hours.thu": "closed", "hours.fri": "closed", "hours.sat": "closed" });
    expect(ok.statusCode).toBe(303);
    const cfg = (await db.query("SELECT config FROM shops WHERE id = $1", [id])).rows[0].config;
    expect(cfg).toMatchObject({ testShop: true, maxPartsPerReply: 2, stockDisplay: "quantity" });
    expect(cfg.businessHours.days.sun).toHaveLength(1);

    // Staff: stored E.164, shown masked, never in the audit log.
    expect((await post(`/admin/shops/${id}/staff`, { name: "أحمد", phone: "0551234567", notify: "1" })).statusCode).toBe(303);
    expect((await db.query("SELECT config FROM shops WHERE id = $1", [id])).rows[0].config.staff).toEqual([{ name: "أحمد", phone: "+966551234567", notify: true }]);
    const page = await get(`/admin/shops/${id}`);
    expect(page.body).toContain("•••••••••4567");
    expect(page.body).not.toContain("551234567");
    const badPhone = await post(`/admin/shops/${id}/staff`, { name: "x", phone: "12ab" });
    expect(badPhone.statusCode).toBe(400);
    expect(badPhone.body).not.toContain("12ab");

    // Stock import via multipart (CSRF field first).
    const boundary = "----partsbot";
    const csv = "رقم الصنف,اسم الصنف,الكمية\n04465-06090,فحمات,4\n,بدون رقم,1\n";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stock.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const imp = await a.inject({ method: "POST", url: `/admin/shops/${id}/import`, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect(imp.statusCode).toBe(303);
    const hist = (await db.query("SELECT status, rows_imported, rows_rejected FROM inventory_imports WHERE shop_id = $1", [id])).rows;
    expect(hist).toEqual([{ status: "completed", rows_imported: 1, rows_rejected: 1 }]);
    const wrongType = `--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.exe"\r\n\r\nMZ\r\n--${boundary}--\r\n`;
    expect((await a.inject({ method: "POST", url: `/admin/shops/${id}/import`, headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: wrongType })).statusCode).toBe(400);

    expect((await post(`/admin/shops/${id}/staff/remove`, { name: "أحمد" })).statusCode).toBe(303);

    const audit = (await db.query("SELECT action, details FROM admin_audit_log WHERE shop_id = $1 ORDER BY id", [id])).rows;
    expect(audit.map((r) => r.action)).toEqual(["shop.create", "shop.settings", "staff.add", "stock.import", "staff.remove"]);
    expect(JSON.stringify(audit)).not.toContain("551234567");
    const auditPage = await get("/admin/audit");
    expect(auditPage.body).toContain("(Riyadh)");
  });

  const loadSynonymIndex = async (d: Db) => new SynonymIndex(await loadActiveSynonyms(d));
  it("synonyms: add, edit, delete, approve/reject suggestions, all audited; suggestions never apply by themselves", async () => {
    const tag = `t${Date.now() % 100000}`;
    const term = `كرتونة ${tag}`;
    try {
      const add = await post("/admin/synonyms", { term, canonical_ar: "فلتر زيت", canonical_en: "oil filter" });
      expect(add.statusCode).toBe(303);
      const row = (await db.query("SELECT id FROM synonyms WHERE term = $1", [term])).rows[0];
      expect(row).toBeTruthy();
      expect((await get("/admin/synonyms")).body).toContain(tag);
      const dup = await post("/admin/synonyms", { term, canonical_ar: "فلتر هواء", canonical_en: "" });
      expect(dup.statusCode).toBe(400);

      expect((await post(`/admin/synonyms/${row.id}`, { term, canonical_ar: "فلتر هواء", canonical_en: "air filter", status: "disabled" })).statusCode).toBe(303);
      expect((await loadSynonymIndex(db)).has(term)).toBe(false); // disabled rows are not used
      expect((await post(`/admin/synonyms/${row.id}/delete`, {})).statusCode).toBe(303);
      expect((await db.query("SELECT 1 FROM synonyms WHERE id = $1", [row.id])).rowCount).toBe(0);

      // AI suggestions wait for a decision.
      const sTerm = `دبة ${tag}`;
      await recordSuggestion(db, { term: sTerm, canonicalAr: "خزان ماء الغسيل", canonicalEn: "washer tank" });
      await recordSuggestion(db, { term: sTerm, canonicalAr: "خزان ماء الغسيل", canonicalEn: "washer tank" });
      const sug = (await db.query("SELECT id, seen_count FROM synonym_suggestions WHERE term = $1", [sTerm])).rows[0];
      expect(sug.seen_count).toBe(2);
      expect((await loadSynonymIndex(db)).has(sTerm)).toBe(false);
      expect((await get("/admin/synonyms")).body).toContain(tag);
      expect((await post(`/admin/synonym-suggestions/${sug.id}/approve`, { canonical_ar: "خزان ماء المساحات" })).statusCode).toBe(303);
      expect((await loadSynonymIndex(db)).has(sTerm)).toBe(true);
      expect((await db.query("SELECT canonical_ar, source FROM synonyms WHERE term = $1", [sTerm])).rows[0]).toEqual({ canonical_ar: "خزان ماء المساحات", source: "suggestion" });
      expect((await post(`/admin/synonym-suggestions/${sug.id}/reject`, {})).statusCode).toBe(409); // already decided

      const rTerm = `زفت ${tag}`;
      await recordSuggestion(db, { term: rTerm, canonicalAr: "شي غلط", canonicalEn: "" });
      const rs = (await db.query("SELECT id FROM synonym_suggestions WHERE term = $1", [rTerm])).rows[0];
      expect((await post(`/admin/synonym-suggestions/${rs.id}/reject`, {})).statusCode).toBe(303);
      expect((await loadSynonymIndex(db)).has(rTerm)).toBe(false);

      const audit = await db.query("SELECT action FROM admin_audit_log WHERE details::text LIKE $1 ORDER BY at", [`%${tag}%`]);
      expect(audit.rows.map((r) => r.action)).toEqual(["synonym.add", "synonym.update", "synonym.delete", "synonym.suggestion.approve", "synonym.suggestion.reject"]);
    } finally {
      await db.query("DELETE FROM synonyms WHERE term LIKE $1", [`%${tag}`]);
      await db.query("DELETE FROM synonym_suggestions WHERE term LIKE $1", [`%${tag}`]);
    }
  });
});
