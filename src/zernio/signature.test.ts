import { describe, expect, it } from "vitest";
import { computeSignature, verifySignature } from "./signature.js";

const secret = "test-secret-0123456789abcdef";
const body = JSON.stringify({ id: "e1", event: "message.received" });

describe("verifySignature", () => {
  it("accepts the HMAC-SHA256 hex of the raw body", () => {
    expect(verifySignature(body, computeSignature(body, secret), secret)).toBe(true);
    expect(verifySignature(Buffer.from(body), computeSignature(body, secret), secret)).toBe(true);
  });

  it("matches a known HMAC-SHA256 vector", () => {
    // HMAC_SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
    expect(computeSignature("The quick brown fox jumps over the lazy dog", "key")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(body + " ", computeSignature(body, secret), secret)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifySignature(body, computeSignature(body, "another-secret-0123456789"), secret)).toBe(false);
  });

  it("rejects missing, malformed or wrong-length signatures without throwing", () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
    expect(verifySignature(body, "zz".repeat(32), secret)).toBe(false);
    expect(verifySignature(body, "abcd", secret)).toBe(false);
    expect(verifySignature(body, computeSignature(body, secret), "")).toBe(false);
  });
});
