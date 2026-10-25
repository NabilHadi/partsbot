import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Zernio webhook signature (https://docs.zernio.com/webhooks#signatures):
 * `X-Zernio-Signature` (legacy alias `X-Late-Signature`) is the lowercase hex HMAC-SHA256 of the
 * RAW request body, keyed by the secret we registered on the webhook endpoint.
 *
 * The documented scheme has NO timestamp in the signature, so there is no replay window here.
 * (The `timestamp` in the body is the event time and is unchanged on retries for up to ~51h,
 * so rejecting "old" events would drop legitimate retries.) Replays are handled by
 * idempotent processing instead, see routes/zernio-webhook.ts.
 */
export const SIGNATURE_HEADERS = ["x-zernio-signature", "x-late-signature"] as const;

export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** Constant-time check of a signature header value against the raw body. Never throws. */
export function verifySignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret || typeof signatureHeader !== "string") return false;
  const given = signatureHeader.trim().toLowerCase();
  if (!HEX_SHA256.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(given, "hex"), expected);
}
