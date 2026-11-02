import { describe, expect, it } from "vitest";
import { LoginRateLimiter, SessionSigner, passwordMatches, readCookie, sessionCookieHeader } from "./auth.js";

describe("admin auth primitives", () => {
  it("password check: exact match only, empty expected never matches", () => {
    expect(passwordMatches("correct horse", "correct horse")).toBe(true);
    expect(passwordMatches("correct hors", "correct horse")).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
    expect(passwordMatches("x".repeat(5000), "correct horse")).toBe(false);
  });

  it("signed session cookie: round-trips, rejects tampering, other keys and expiry", () => {
    const s = new SessionSigner();
    const { session, cookie } = s.issue(true, 1000);
    expect(s.verify(cookie, 2000)).toEqual(session);
    const [body, sig] = cookie.split(".");
    const forged = Buffer.from(JSON.stringify({ ...session, auth: true, exp: 9e15 })).toString("base64url");
    expect(s.verify(`${forged}.${sig}`, 2000)).toBeNull();
    expect(s.verify(`${body}.${sig}x`, 2000)).toBeNull();
    expect(new SessionSigner().verify(cookie, 2000)).toBeNull();
    expect(s.verify(cookie, session.exp + 1)).toBeNull();
    expect(s.verify(undefined)).toBeNull();
    expect(s.verify("garbage")).toBeNull();
  });

  it("csrf token is bound to the session", () => {
    const s = new SessionSigner();
    const a = s.issue(false).session;
    const b = s.issue(false).session;
    expect(s.csrfValid(a, s.csrfToken(a))).toBe(true);
    expect(s.csrfValid(b, s.csrfToken(a))).toBe(false);
    expect(s.csrfValid(a, undefined)).toBe(false);
    expect(s.csrfValid(a, "")).toBe(false);
  });

  it("cookie attributes", () => {
    const h = sessionCookieHeader("v", 60_000);
    expect(h).toContain("HttpOnly");
    expect(h).toContain("Secure");
    expect(h).toContain("SameSite=Strict");
    expect(h).toContain("Path=/admin");
    expect(readCookie("a=1; pb_admin=xyz; b=2", "pb_admin")).toBe("xyz");
  });

  it("rate limit: per client and global, window slides", () => {
    const l = new LoginRateLimiter({ windowMs: 1000, maxPerClient: 3, maxGlobal: 5 });
    for (let i = 0; i < 3; i++) l.fail("a", 0);
    expect(l.retryAfter("a", 10)).toBe(1);
    expect(l.retryAfter("b", 10)).toBe(0);
    l.fail("b", 10);
    l.fail("c", 10);
    expect(l.retryAfter("d", 20)).toBeGreaterThan(0); // global cap
    expect(l.retryAfter("a", 1001)).toBe(0);
  });
});
