import { describe, expect, test } from "bun:test";
import { generateMasterKey, getDefaultOwnerName } from "../setup-identity.ts";

describe("getDefaultOwnerName", () => {
  test("returns a non-empty string", () => {
    const name = getDefaultOwnerName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("generateMasterKey", () => {
  test("returns a 64-character hex string", () => {
    const key = generateMasterKey();
    expect(key).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(key)).toBe(true);
  });

  test("generates unique keys on each call", () => {
    const key1 = generateMasterKey();
    const key2 = generateMasterKey();
    expect(key1).not.toBe(key2);
  });
});
