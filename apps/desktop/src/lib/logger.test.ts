/**
 * Tests for desktop client logger with ring buffer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearErrorBuffer, clientLog, getRecentErrors } from "./logger";

describe("clientLog", () => {
  beforeEach(() => {
    clearErrorBuffer();
  });

  afterEach(() => {
    clearErrorBuffer();
  });

  test("error level is stored in ring buffer", () => {
    clientLog("error", "test", "error msg");
    const errors = getRecentErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.level).toBe("error");
    expect(errors[0]!.module).toBe("test");
    expect(errors[0]!.message).toBe("error msg");
  });

  test("warn level is stored in ring buffer", () => {
    clientLog("warn", "test", "warn msg");
    expect(getRecentErrors()).toHaveLength(1);
    expect(getRecentErrors()[0]!.level).toBe("warn");
  });

  test("info level is NOT stored in ring buffer", () => {
    clientLog("info", "test", "info msg");
    expect(getRecentErrors()).toHaveLength(0);
  });

  test("debug level is NOT stored in ring buffer", () => {
    clientLog("debug", "test", "debug msg");
    expect(getRecentErrors()).toHaveLength(0);
  });

  test("stores data as serializable copy", () => {
    const data = { key: "val" };
    clientLog("error", "test", "with data", data);
    expect(getRecentErrors()[0]!.data).toEqual({ key: "val" });
    expect(getRecentErrors()[0]!.data).not.toBe(data);
  });

  test("handles circular references in data", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    clientLog("error", "test", "circular", obj);
    expect(getRecentErrors()).toHaveLength(1);
    expect(typeof getRecentErrors()[0]!.data).toBe("string");
  });

  test("ring buffer caps at 100 entries", () => {
    for (let i = 0; i < 105; i++) {
      clientLog("error", "test", `msg-${i}`);
    }
    const errors = getRecentErrors();
    expect(errors).toHaveLength(100);
    expect(errors[0]!.message).toBe("msg-5");
    expect(errors[99]!.message).toBe("msg-104");
  });

  test("timestamp is populated", () => {
    const before = Date.now();
    clientLog("error", "test", "ts");
    const after = Date.now();
    const ts = getRecentErrors()[0]!.timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("clearErrorBuffer", () => {
  test("clears all entries", () => {
    clientLog("error", "test", "a");
    clientLog("warn", "test", "b");
    expect(getRecentErrors()).toHaveLength(2);
    clearErrorBuffer();
    expect(getRecentErrors()).toHaveLength(0);
  });
});

describe("getRecentErrors", () => {
  beforeEach(() => clearErrorBuffer());

  test("returns a copy", () => {
    clientLog("error", "test", "x");
    const a = getRecentErrors();
    const b = getRecentErrors();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
