import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "../crypto.ts";

const TEST_KEY = randomBytes(32);

describe("crypto", () => {
  test("encrypt/decrypt roundtrip produces original value", () => {
    const original = "super-secret-api-key-12345";
    const encrypted = encrypt(original, TEST_KEY);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    const decrypted = decrypt(encrypted.value, TEST_KEY);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) return;
    expect(decrypted.value).toBe(original);
  });

  test("different master keys produce different ciphertext", () => {
    const value = "same-value";
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);

    const enc1 = encrypt(value, key1);
    const enc2 = encrypt(value, key2);
    expect(enc1.ok).toBe(true);
    expect(enc2.ok).toBe(true);
    if (!enc1.ok || !enc2.ok) return;

    expect(enc1.value.ciphertext.equals(enc2.value.ciphertext)).toBe(false);
  });

  test("tampering with ciphertext fails decryption", () => {
    const encrypted = encrypt("test-value", TEST_KEY);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    // Flip a byte in the ciphertext
    const tampered = Buffer.from(encrypted.value.ciphertext);
    const byte0 = tampered[0] ?? 0;
    tampered[0] = byte0 ^ 0xff;

    const result = decrypt({ ...encrypted.value, ciphertext: tampered }, TEST_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECRET_DECRYPTION_FAILED");
    }
  });

  test("tampering with auth tag fails decryption", () => {
    const encrypted = encrypt("test-value", TEST_KEY);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    // Flip a byte in the auth tag
    const tampered = Buffer.from(encrypted.value.authTag);
    const byte0 = tampered[0] ?? 0;
    tampered[0] = byte0 ^ 0xff;

    const result = decrypt({ ...encrypted.value, authTag: tampered }, TEST_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECRET_DECRYPTION_FAILED");
    }
  });

  test("wrong master key fails decryption", () => {
    const encrypted = encrypt("test-value", TEST_KEY);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    const wrongKey = randomBytes(32);
    const result = decrypt(encrypted.value, wrongKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECRET_DECRYPTION_FAILED");
    }
  });
});
