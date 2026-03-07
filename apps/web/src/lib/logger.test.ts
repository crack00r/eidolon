/**
 * Tests for web client logger with ring buffer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearErrorBuffer, clientLog, getRecentErrors } from "./logger";

describe("clientLog", () => {
  beforeEach(() => {
    clearErrorBuffer();
  });

  afterEach(() => {
    clearErrorBuffer();
  });

  test("error level is stored in ring buffer", () => {
    clientLog("error", "test-module", "something broke");
    const errors = getRecentErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.level).toBe("error");
    expect(errors[0]!.module).toBe("test-module");
    expect(errors[0]!.message).toBe("something broke");
    expect(errors[0]!.timestamp).toBeGreaterThan(0);
  });

  test("warn level is stored in ring buffer", () => {
    clientLog("warn", "network", "connection lost");
    const errors = getRecentErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.level).toBe("warn");
  });

  test("info level is NOT stored in ring buffer", () => {
    clientLog("info", "app", "started");
    expect(getRecentErrors()).toHaveLength(0);
  });

  test("debug level is NOT stored in ring buffer", () => {
    clientLog("debug", "app", "trace info");
    expect(getRecentErrors()).toHaveLength(0);
  });

  test("stores structured data as serializable copy", () => {
    const data = { key: "value", nested: { x: 1 } };
    clientLog("error", "test", "with data", data);
    const errors = getRecentErrors();
    expect(errors[0]!.data).toEqual({ key: "value", nested: { x: 1 } });
    // Should be a deep copy, not the same reference
    expect(errors[0]!.data).not.toBe(data);
  });

  test("handles non-serializable data gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // JSON.stringify will throw for circular refs; logger converts to String
    clientLog("error", "test", "circular ref", circular);
    const errors = getRecentErrors();
    expect(errors).toHaveLength(1);
    // Should have stringified fallback
    expect(typeof errors[0]!.data).toBe("string");
  });

  test("ring buffer evicts oldest entries beyond 100", () => {
    for (let i = 0; i < 110; i++) {
      clientLog("error", "bulk", `msg-${i}`);
    }
    const errors = getRecentErrors();
    expect(errors).toHaveLength(100);
    // Oldest should be msg-10 (first 10 evicted)
    expect(errors[0]!.message).toBe("msg-10");
    expect(errors[99]!.message).toBe("msg-109");
  });

  test("entry without data has no data field", () => {
    clientLog("error", "test", "no data");
    const errors = getRecentErrors();
    expect(errors[0]!.data).toBeUndefined();
  });
});

describe("getRecentErrors", () => {
  beforeEach(() => {
    clearErrorBuffer();
  });

  test("returns empty array when no errors logged", () => {
    expect(getRecentErrors()).toEqual([]);
  });

  test("returns a copy, not the internal buffer", () => {
    clientLog("error", "test", "entry");
    const a = getRecentErrors();
    const b = getRecentErrors();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("clearErrorBuffer", () => {
  beforeEach(() => {
    clearErrorBuffer();
  });

  test("empties the buffer", () => {
    clientLog("error", "test", "entry");
    expect(getRecentErrors()).toHaveLength(1);
    clearErrorBuffer();
    expect(getRecentErrors()).toHaveLength(0);
  });
});
