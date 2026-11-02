import { describe, expect, it } from "vitest";
import { MissingKeyError, decryptField, encryptField, loadSecretsKey, maskPhone, staffPhoneContext } from "./field-crypto.js";

const key = Buffer.alloc(32, 9);
const PHONE = "+966501234567";

describe("field crypto (staff phones)", () => {
  it("round-trips, uses a fresh IV, and never contains the plain digits", () => {
    const a = encryptField(PHONE, key, staffPhoneContext("shop_1"));
    const b = encryptField(PHONE, key, staffPhoneContext("shop_1"));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain("501234567");
    expect(decryptField(a, key, staffPhoneContext("shop_1"))).toBe(PHONE);
  });
  it("fails for another shop, another key or a tampered value", () => {
    const a = encryptField(PHONE, key, staffPhoneContext("shop_1"));
    expect(() => decryptField(a, key, staffPhoneContext("shop_2"))).toThrow();
    expect(() => decryptField(a, Buffer.alloc(32, 1), staffPhoneContext("shop_1"))).toThrow();
    const parts = a.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptField(parts.join("."), key, staffPhoneContext("shop_1"))).toThrow();
  });
  it("key from env: missing or wrong length is an error naming only the variable", () => {
    expect(() => loadSecretsKey({})).toThrow(MissingKeyError);
    expect(() => loadSecretsKey({ SHOP_SECRETS_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/32 bytes/);
    expect(loadSecretsKey({ SHOP_SECRETS_KEY: key.toString("base64") }).equals(key)).toBe(true);
  });
  it("masks to the last two digits", () => {
    expect(maskPhone("67")).toBe("•••••••••67");
  });
});
