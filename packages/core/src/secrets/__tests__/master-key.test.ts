import { beforeEach, describe, expect, test } from "bun:test";
import { generateMasterKey, getMasterKey } from "../master-key.ts";

describe("master-key", () => {
  const originalEnv = process.env.EIDOLON_MASTER_KEY;

  beforeEach(() => {
    // Reset env before each test
    if (originalEnv !== undefined) {
      process.env.EIDOLON_MASTER_KEY = originalEnv;
    } else {
      delete process.env.EIDOLON_MASTER_KEY;
    }
  });

  test("getMasterKey() returns MASTER_KEY_MISSING when env not set", () => {
    delete process.env.EIDOLON_MASTER_KEY;
    const result = getMasterKey();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MASTER_KEY_MISSING");
    }
  });

  test("getMasterKey() reads hex key from EIDOLON_MASTER_KEY env", () => {
    const hexKey = "a".repeat(64);
    process.env.EIDOLON_MASTER_KEY = hexKey;

    const result = getMasterKey();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(32);
      expect(result.value.toString("hex")).toBe(hexKey);
    }
  });

  test("hex key (64 chars) is decoded directly", () => {
    const hexKey = "0123456789abcdef".repeat(4); // 64 hex chars
    process.env.EIDOLON_MASTER_KEY = hexKey;

    const result = getMasterKey();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(32);
      expect(result.value.toString("hex")).toBe(hexKey);
    }
  });

  test("non-hex passphrase is hashed to 32 bytes", () => {
    process.env.EIDOLON_MASTER_KEY = "my-secret-passphrase";

    const result = getMasterKey();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(32);
      // Should be a SHA-256 hash, not the raw passphrase
      expect(result.value.toString("utf8")).not.toBe("my-secret-passphrase");
    }
  });

  test("generateMasterKey() returns 64-char hex string", () => {
    const key = generateMasterKey();
    expect(key).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  test("generateMasterKey() produces unique keys", () => {
    const key1 = generateMasterKey();
    const key2 = generateMasterKey();
    expect(key1).not.toBe(key2);
  });
});
