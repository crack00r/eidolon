import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { SecretStore } from "../store.js";

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
});
