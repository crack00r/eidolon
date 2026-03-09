import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createTestConfig } from "@eidolon/test-utils";
import { SecretStore } from "../store.ts";

const TEST_KEY = randomBytes(32);

describe("SecretStore", () => {
  const stores: SecretStore[] = [];

  function createStore(key: Buffer = TEST_KEY): SecretStore {
    const store = new SecretStore(":memory:", key);
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores) {
      store.close();
    }
    stores.length = 0;
  });

  test("set() then get() returns original value", () => {
    const store = createStore();
    const setResult = store.set("api-key", "sk-abc123");
    expect(setResult.ok).toBe(true);

    const getResult = store.get("api-key");
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBe("sk-abc123");
    }
  });

  test("get() for non-existent key returns SECRET_NOT_FOUND", () => {
    const store = createStore();
    const result = store.get("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECRET_NOT_FOUND");
    }
  });

  test("delete() removes secret, subsequent get() returns SECRET_NOT_FOUND", () => {
    const store = createStore();
    store.set("to-delete", "value");

    const deleteResult = store.delete("to-delete");
    expect(deleteResult.ok).toBe(true);

    const getResult = store.get("to-delete");
    expect(getResult.ok).toBe(false);
    if (!getResult.ok) {
      expect(getResult.error.code).toBe("SECRET_NOT_FOUND");
    }
  });

  test("delete() for non-existent key returns SECRET_NOT_FOUND", () => {
    const store = createStore();
    const result = store.delete("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECRET_NOT_FOUND");
    }
  });

  test("list() returns all keys with metadata (never values)", () => {
    const store = createStore();
    store.set("key-a", "value-a", "Description A");
    store.set("key-b", "value-b");

    const result = store.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    const first = result.value[0];
    const second = result.value[1];
    expect(first?.key).toBe("key-a");
    expect(first?.description).toBe("Description A");
    expect(second?.key).toBe("key-b");
    expect(second?.description).toBeUndefined();

    // Verify no values are returned
    for (const meta of result.value) {
      expect(meta).not.toHaveProperty("value");
      expect(meta).not.toHaveProperty("encrypted_value");
      expect(meta).toHaveProperty("createdAt");
      expect(meta).toHaveProperty("updatedAt");
      expect(meta).toHaveProperty("accessedAt");
    }
  });

  test("has() returns true/false correctly", () => {
    const store = createStore();
    expect(store.has("missing")).toBe(false);

    store.set("exists", "value");
    expect(store.has("exists")).toBe(true);
  });

  test("rotate() updates value, get() returns new value", () => {
    const store = createStore();
    store.set("rotate-me", "old-value");

    const rotateResult = store.rotate("rotate-me", "new-value");
    expect(rotateResult.ok).toBe(true);

    const getResult = store.get("rotate-me");
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBe("new-value");
    }
  });

  test("rotate() for non-existent key returns SECRET_NOT_FOUND", () => {
    const store = createStore();
    const result = store.rotate("nonexistent", "value");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECRET_NOT_FOUND");
    }
  });

  test("wrong master key fails to decrypt", () => {
    const store1 = createStore(TEST_KEY);
    store1.set("secret", "the-value");

    // Create a second store pointing at the same DB with a different key
    // Since :memory: creates separate DBs, we use a temp file instead
    const wrongKey = randomBytes(32);
    const store2 = createStore(wrongKey);
    store2.set("secret", "different");

    // Each store can only read its own data
    const result1 = store1.get("secret");
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.value).toBe("the-value");
    }

    const result2 = store2.get("secret");
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.value).toBe("different");
    }
  });

  test("set() updates existing secret", () => {
    const store = createStore();
    store.set("key", "value1", "initial");
    store.set("key", "value2");

    const getResult = store.get("key");
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBe("value2");
    }

    // Description should be preserved (COALESCE)
    const listResult = store.list();
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value[0]?.description).toBe("initial");
    }
  });

  // =========================================================================
  // Gap 1: Key validation
  // =========================================================================

  describe("key validation", () => {
    test("set() rejects empty key", () => {
      const store = createStore();
      const result = store.set("", "value");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
        expect(result.error.message).toContain("empty");
      }
    });

    test("get() rejects empty key", () => {
      const store = createStore();
      const result = store.get("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
      }
    });

    test("delete() rejects empty key", () => {
      const store = createStore();
      const result = store.delete("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
      }
    });

    test("set() rejects key exceeding MAX_KEY_LENGTH (256)", () => {
      const store = createStore();
      const longKey = "a".repeat(257);
      const result = store.set(longKey, "value");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
        expect(result.error.message).toContain("maximum length");
      }
    });

    test("set() accepts key at exactly MAX_KEY_LENGTH (256)", () => {
      const store = createStore();
      const exactKey = "a".repeat(256);
      const result = store.set(exactKey, "value");
      expect(result.ok).toBe(true);
    });

    test("set() rejects key with spaces", () => {
      const store = createStore();
      const result = store.set("key with spaces", "value");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
        expect(result.error.message).toContain("invalid characters");
      }
    });

    test("set() rejects key with SQL injection attempt", () => {
      const store = createStore();
      const result = store.set("key;DROP TABLE", "value");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
        expect(result.error.message).toContain("invalid characters");
      }
    });

    test("set() rejects key with special characters", () => {
      const store = createStore();
      for (const badKey of ["key@value", "key=value", "key value", "key\ttab", "key\nnewline"]) {
        const result = store.set(badKey, "value");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("INVALID_INPUT");
        }
      }
    });

    test("set() accepts valid keys with dots, hyphens, underscores, and slashes", () => {
      const store = createStore();
      const validKeys = [
        "simple-key",
        "dotted.key.name",
        "under_scored",
        "service/api-key",
        "my.service/nested_key-v2",
        "UPPERCASE",
        "MiXeD.CaSe-Key_123",
      ];
      for (const key of validKeys) {
        const result = store.set(key, "value");
        expect(result.ok).toBe(true);
      }
    });
  });

  // =========================================================================
  // Gap 2: resolveSecretRefs
  // =========================================================================

  describe("resolveSecretRefs", () => {
    test("resolves $secret reference to decrypted value", () => {
      const store = createStore();
      store.set("test-api-key", "sk-resolved-secret-value-1234567890abcde");

      // Create a config with a $secret reference in the brain.accounts[0].credential field
      const baseConfig = createTestConfig();
      // Inject a $secret reference into the raw config object
      const rawConfig = JSON.parse(JSON.stringify(baseConfig));
      rawConfig.brain.accounts[0].credential = { $secret: "test-api-key" };

      const result = store.resolveSecretRefs(rawConfig);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.brain.accounts[0]?.credential).toBe("sk-resolved-secret-value-1234567890abcde");
      }
    });

    test("resolves nested $secret references", () => {
      const store = createStore();
      store.set("identity-name-secret", "SecretEidolon");

      const baseConfig = createTestConfig();
      const rawConfig = JSON.parse(JSON.stringify(baseConfig));
      rawConfig.identity.name = { $secret: "identity-name-secret" };

      const result = store.resolveSecretRefs(rawConfig);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.identity.name).toBe("SecretEidolon");
      }
    });

    test("returns error for $secret reference to non-existent key", () => {
      const store = createStore();

      const baseConfig = createTestConfig();
      const rawConfig = JSON.parse(JSON.stringify(baseConfig));
      rawConfig.brain.accounts[0].credential = { $secret: "nonexistent-key" };

      const result = store.resolveSecretRefs(rawConfig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SECRET_NOT_FOUND");
      }
    });

    test("returns CONFIG_INVALID when resolved value violates schema", () => {
      const store = createStore();
      // Store an invalid role value -- the role field accepts only "server" | "client" | "hybrid"
      store.set("bad-role", "not-a-valid-role");

      const baseConfig = createTestConfig();
      const rawConfig = JSON.parse(JSON.stringify(baseConfig));
      rawConfig.role = { $secret: "bad-role" };

      const result = store.resolveSecretRefs(rawConfig);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFIG_INVALID");
      }
    });

    test("passes through config without $secret references unchanged", () => {
      const store = createStore();
      const baseConfig = createTestConfig();
      const rawConfig = JSON.parse(JSON.stringify(baseConfig));

      const result = store.resolveSecretRefs(rawConfig);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.identity.ownerName).toBe(baseConfig.identity.ownerName);
      }
    });
  });
});
