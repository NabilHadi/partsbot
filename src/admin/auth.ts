/**
 * Admin auth primitives (pure, unit-tested): one admin user whose password comes from ADMIN_PASSWORD.
 *
 *  - Password check: SHA-256 of both sides, then crypto.timingSafeEqual (equal-length digests, no early exit).
 *  - Session: a signed cookie `pb_admin` = base64url(JSON {sid, auth, exp}) + "." + HMAC-SHA256. The signing key is
 *    32 random bytes per process, so a restart logs everyone out (fine for one admin) and the password is never
 *    usable to forge or brute-force a cookie offline.
 *  - CSRF: every form carries HMAC(key, "csrf:" + sid); every POST must echo it. Logged-out visitors get an
 *    anonymous sid too, so the login form is CSRF-protected as well. A new sid is issued at login (no fixation).
 *  - Login rate limit: failures per client key (CF-Connecting-IP behind the tunnel) AND globally, in memory.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "pb_admin";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const ANON_TTL_MS = 2 * 60 * 60 * 1000;

export interface Session {
  sid: string;
  auth: boolean;
  exp: number;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function passwordMatches(given: string, expected: string): boolean {
  // Hash first so lengths are equal and timingSafeEqual cannot throw or leak the length.
  return timingSafeEqual(sha256(given), sha256(expected)) && expected.length > 0;
}

export class SessionSigner {
  constructor(private readonly key: Buffer = randomBytes(32)) {}

  private mac(data: string): string {
    return createHmac("sha256", this.key).update(data, "utf8").digest("base64url");
  }

  issue(auth: boolean, now = Date.now()): { session: Session; cookie: string } {
    const session: Session = { sid: randomBytes(18).toString("base64url"), auth, exp: now + (auth ? SESSION_TTL_MS : ANON_TTL_MS) };
    const body = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
    return { session, cookie: `${body}.${this.mac(body)}` };
  }

  verify(cookie: string | undefined, now = Date.now()): Session | null {
    if (!cookie || cookie.length > 512) return null;
    const dot = cookie.indexOf(".");
    if (dot <= 0) return null;
    const body = cookie.slice(0, dot);
    const sig = Buffer.from(cookie.slice(dot + 1), "utf8");
    const want = Buffer.from(this.mac(body), "utf8");
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
      if (typeof s.sid !== "string" || typeof s.auth !== "boolean" || typeof s.exp !== "number") return null;
      if (s.exp <= now) return null;
      return s;
    } catch {
      return null;
    }
  }

  csrfToken(session: Session): string {
    return this.mac(`csrf:${session.sid}`);
  }

  csrfValid(session: Session, token: unknown): boolean {
    if (typeof token !== "string" || token.length === 0 || token.length > 128) return false;
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(this.csrfToken(session), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export function sessionCookieHeader(value: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}
export const clearSessionCookieHeader = `${SESSION_COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Sliding-window failure counter: per client and global. Successful logins do not reset the global window. */
export class LoginRateLimiter {
  private readonly perClient = new Map<string, number[]>();
  private global: number[] = [];
  constructor(
    private readonly opts = { windowMs: 15 * 60 * 1000, maxPerClient: 5, maxGlobal: 30 },
  ) {}

  private prune(list: number[], now: number): number[] {
    return list.filter((t) => now - t < this.opts.windowMs);
  }

  /** Seconds to wait before another attempt is allowed, or 0. */
  retryAfter(client: string, now = Date.now()): number {
    const mine = this.prune(this.perClient.get(client) ?? [], now);
    this.global = this.prune(this.global, now);
    const blockedBy = (list: number[], max: number) => (list.length >= max ? (list[list.length - max] as number) + this.opts.windowMs - now : 0);
    const wait = Math.max(blockedBy(mine, this.opts.maxPerClient), blockedBy(this.global, this.opts.maxGlobal));
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(client: string, now = Date.now()): void {
    const mine = this.prune(this.perClient.get(client) ?? [], now);
    mine.push(now);
    this.perClient.set(client, mine);
    this.global.push(now);
    if (this.perClient.size > 10_000) this.perClient.clear(); // memory bound
  }

  succeed(client: string): void {
    this.perClient.delete(client);
  }
}
