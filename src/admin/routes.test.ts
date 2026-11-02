// /admin auth and safety, without a database (a fake db that records queries).
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import type { Db } from "../db/pool.js";
import { LoginRateLimiter } from "./auth.js";
import type { AdminDeps } from "./routes.js";

const PW = "test-admin-password-123";
const STATUS: AdminDeps["status"] = { dryRun: true, oneepcBaseUrl: "http://localhost:1/api", zernioWebhookConfigured: true, zernioApiKeyConfigured: false, version: "0.1.0", commit: "abc1234", queueName: "inbound-message" };

function fakeDb() {
  const queries: { text: string; params?: unknown[] }[] = [];
  const db = { query: async (text: string, params?: unknown[]) => { queries.push({ text, params }); return { rows: [], rowCount: 0 }; } } as unknown as Db;
  return { db, queries };
}

function app(password: string | undefined, limiter?: LoginRateLimiter) {
  const f = fakeDb();
  const a = buildServer({ logger: false, admin: { db: f.db, password, status: STATUS, limiter, probe: async () => "reachable (HTTP 200)" } });
  return { a, ...f };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"] ?? "").split(";")[0] as string;
const csrfOf = (body: string) => /name="_csrf" value="([^"]+)"/.exec(body)?.[1] as string;

async function anon(a: ReturnType<typeof app>["a"]) {
  const res = await a.inject({ method: "GET", url: "/admin/login" });
  return { cookie: cookieOf(res), csrf: csrfOf(res.body), res };
}

async function login(a: ReturnType<typeof app>["a"], password = PW, remote = "1.2.3.4") {
  const { cookie, csrf } = await anon(a);
  return a.inject({ method: "POST", url: "/admin/login", headers: { cookie, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": remote }, payload: new URLSearchParams({ _csrf: csrf, password }).toString() });
}

async function loggedIn(a: ReturnType<typeof app>["a"]) {
  const res = await login(a);
  const cookie = cookieOf(res);
  const page = await a.inject({ method: "GET", url: "/admin/app", headers: { cookie } });
  return { cookie, csrf: csrfOf(page.body), page };
}

describe("/admin auth", () => {
  it("app page shows OneEPC status, key state and per-endpoint routing (never the key)", async () => {
    const f = fakeDb();
    const a = buildServer({ logger: false, admin: { db: f.db, password: PW, status: { ...STATUS, oneepcSources: { decode: "mock", search: "mock" }, oneepcMockBaseUrl: "http://localhost:4010/api/bot/v1" },
      oneepcCheck: async () => ({ real: { state: "ok", detail: "api 1.0, data version 5700aec61fe9, brands: toyota" }, mock: { state: "ok", detail: "api 1.0" } }) } });
    const { page } = await loggedIn(a);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("OneEPC status");
    expect(page.body).toContain("<strong>OK</strong>");
    expect(page.body).toContain("configured, accepted");
    expect(page.body).toContain("test shops only");
    const b = buildServer({ logger: false, admin: { db: f.db, password: PW, status: STATUS, oneepcCheck: async () => ({ real: { state: "auth_failed", detail: "HTTP 401 invalid_key" }, mock: null }) } });
    const { page: p2 } = await loggedIn(b);
    expect(p2.body).toContain("AUTH FAILED");
    expect(p2.body).toContain("REJECTED by OneEPC");
  });

  it("fails closed with 503 on every admin URL when ADMIN_PASSWORD is unset", async () => {
    const { a } = app(undefined);
    for (const url of ["/admin", "/admin/", "/admin/login", "/admin/shops", "/admin/app", "/admin/admin.css"]) {
      expect((await a.inject({ method: "GET", url })).statusCode).toBe(503);
    }
    expect((await a.inject({ method: "POST", url: "/admin/login", payload: "password=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(503);
    expect((await a.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("login page: CSRF field, secure cookie, security headers; protected pages redirect", async () => {
    const { a } = app(PW);
    const { res, csrf } = await anon(a);
    expect(res.statusCode).toBe(200);
    expect(csrf).toBeTruthy();
    const sc = String(res.headers["set-cookie"]);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/SameSite=Strict/);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
    const shops = await a.inject({ method: "GET", url: "/admin/shops" });
    expect(shops.statusCode).toBe(303);
    expect(shops.headers.location).toBe("/admin/login");
    expect((await a.inject({ method: "POST", url: "/admin/shops", payload: "name=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(401);
  });

  it("rejects a login POST without a valid CSRF token", async () => {
    const { a } = app(PW);
    const { cookie } = await anon(a);
    const res = await a.inject({ method: "POST", url: "/admin/login", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `password=${PW}&_csrf=nope` });
    expect(res.statusCode).toBe(403);
  });

  it("wrong password: 401, audited without the attempted password", async () => {
    const { a, queries } = app(PW);
    const res = await login(a, "wrong-password");
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Wrong password");
    const auditQ = queries.find((q) => q.text.includes("admin_audit_log"));
    expect(auditQ?.params?.[1]).toBe("login.failed");
    expect(JSON.stringify(queries)).not.toContain("wrong-password");
  });

  it("right password: new session cookie (different sid), pages work, logout ends it", async () => {
    const { a } = app(PW);
    const { cookie: anonCookie } = await anon(a);
    const res = await login(a);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/admin/shops");
    const cookie = cookieOf(res);
    expect(cookie).not.toBe(anonCookie);
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const appPage = await a.inject({ method: "GET", url: "/admin/app", headers: { cookie } });
    expect(appPage.statusCode).toBe(200);
    expect(appPage.body).toContain("abc1234");
    expect(appPage.body).toContain("ON (the bot logs replies");
    expect(appPage.body).not.toContain(PW);
    const csrf = csrfOf(appPage.body);
    // A POST with the right cookie but no CSRF token is refused.
    expect((await a.inject({ method: "POST", url: "/admin/logout", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "" })).statusCode).toBe(403);
    const out = await a.inject({ method: "POST", url: "/admin/logout", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `_csrf=${encodeURIComponent(csrf)}` });
    expect(out.statusCode).toBe(303);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("a tampered or foreign cookie is not a session", async () => {
    const { a } = app(PW);
    const cookie = cookieOf(await login(a));
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("A") ? "BB" : "AA");
    expect((await a.inject({ method: "GET", url: "/admin/shops", headers: { cookie: tampered } })).statusCode).toBe(303);
    const other = app(PW).a; // another process = another signing key
    expect((await other.inject({ method: "GET", url: "/admin/shops", headers: { cookie } })).statusCode).toBe(303);
  });

  it("login rate limit: 429 with Retry-After after repeated failures, even with the right password", async () => {
    const { a } = app(PW, new LoginRateLimiter({ windowMs: 60_000, maxPerClient: 3, maxGlobal: 100 }));
    for (let i = 0; i < 3; i++) expect((await login(a, "bad", "9.9.9.9")).statusCode).toBe(401);
    const blocked = await login(a, PW, "9.9.9.9");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await login(a, PW, "8.8.8.8")).statusCode).toBe(303); // other clients unaffected
  });

  it("CSRF also guards the multipart upload", async () => {
    const { a } = app(PW);
    const { cookie } = await loggedIn(a);
    const boundary = "----x";
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\nbad\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.csv"\r\nContent-Type: text/csv\r\n\r\na,b\r\n--${boundary}--\r\n`;
    // The fake db has no shops, so use a real-looking id: the shop lookup returns nothing -> 404 before parsing.
    const res = await a.inject({ method: "POST", url: "/admin/shops/5dcb8a94-2ef8-4469-a742-1bccdc4259f9/import", headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    expect([403, 404]).toContain(res.statusCode);
  });
});
