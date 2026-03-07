/**
 * Tests for web client utility functions.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeErrorForDisplay } from "./utils";

describe("sanitizeErrorForDisplay", () => {
  test("returns fallback for non-Error values", () => {
    expect(sanitizeErrorForDisplay("string")).toBe("An unexpected error occurred");
    expect(sanitizeErrorForDisplay(null)).toBe("An unexpected error occurred");
    expect(sanitizeErrorForDisplay(undefined)).toBe("An unexpected error occurred");
    expect(sanitizeErrorForDisplay(42)).toBe("An unexpected error occurred");
    expect(sanitizeErrorForDisplay({})).toBe("An unexpected error occurred");
  });

  test("returns custom fallback for non-Error values", () => {
    expect(sanitizeErrorForDisplay("oops", "Custom fallback")).toBe("Custom fallback");
  });

  test("returns error message for Error instances", () => {
    expect(sanitizeErrorForDisplay(new Error("Something broke"))).toBe("Something broke");
  });

  test("strips Unix file paths from error messages", () => {
    const err = new Error("Failed at /home/user/project/src/file.ts: some issue");
    const result = sanitizeErrorForDisplay(err);
    expect(result).not.toContain("/home/user/project/src/file.ts");
    expect(result).toContain("[path]");
    expect(result).toContain("some issue");
  });

  test("strips Windows file paths from error messages", () => {
    const err = new Error("Failed at C:\\Users\\user\\project\\src\\file.ts: some issue");
    const result = sanitizeErrorForDisplay(err);
    expect(result).not.toContain("C:\\Users\\user\\project\\src\\file.ts");
    expect(result).toContain("[path]");
  });

  test("strips stack traces from error messages", () => {
    const err = new Error("Connection failed\n    at Object.connect (/src/api.ts:42)\n    at main (/src/index.ts:10)");
    const result = sanitizeErrorForDisplay(err);
    expect(result).not.toContain("at Object.connect");
    expect(result).not.toContain("at main");
    expect(result).toBe("Connection failed");
  });

  test("returns fallback for Error with empty message", () => {
    const err = new Error("");
    const result = sanitizeErrorForDisplay(err);
    expect(result).toBe("An unexpected error occurred");
  });

  test("returns fallback for Error with only path as message", () => {
    const err = new Error("/some/path/file.ts");
    const result = sanitizeErrorForDisplay(err);
    // After replacement, only "[path]" remains
    expect(result).toBe("[path]");
  });

  test("handles multiple paths in one message", () => {
    const err = new Error("Error in /a/b.ts and /c/d.js");
    const result = sanitizeErrorForDisplay(err);
    expect(result).toBe("Error in [path] and [path]");
  });
});
