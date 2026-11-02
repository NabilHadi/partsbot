/**
 * Field-level encryption for personal data kept in JSON config (staff WhatsApp numbers; PDPL).
 * AES-256-GCM, a random 96-bit IV per value, and associated data that binds a ciphertext to its shop and
 * purpose (a value copied into another shop or field fails to decrypt).
 *
 * Key: env SHOP_SECRETS_KEY = 32 random bytes, base64 (generate: `openssl rand -base64 32`).
 * The key never goes in the database, git or logs. Losing it means re-entering staff numbers.
 * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url parts).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRETS_KEY_ENV = "SHOP_SECRETS_KEY";

export class MissingKeyError extends Error {
  constructor() {
    super(`${SECRETS_KEY_ENV} is not set (32 random bytes, base64); needed to store or read staff phone numbers`);
    this.name = "MissingKeyError";
  }
}

export function loadSecretsKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[SECRETS_KEY_ENV];
  if (!raw) throw new MissingKeyError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${SECRETS_KEY_ENV} must decode to exactly 32 bytes`);
  return key;
}

const b64u = (b: Buffer) => b.toString("base64url");

export function encryptField(plain: string, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", b64u(iv), b64u(c.getAuthTag()), b64u(data)].join(".");
}

export function decryptField(token: string, key: Buffer, context: string): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("not an encrypted field");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(context, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

/** Associated data for a staff phone number of a given shop. */
export const staffPhoneContext = (shopId: string) => `partsbot:shop:${shopId}:staff-phone:v1`;

/** "•••••••••67": the last two digits only (all the config keeps in clear). */
export function maskPhone(hint: string): string {
  return `•••••••••${hint}`;
}
