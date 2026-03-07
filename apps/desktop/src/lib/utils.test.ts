/**
 * Tests for desktop client utility functions.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeErrorForDisplay } from "./utils";

describe("sanitizeErrorForDisplay", () => {
  test("returns fallback for non-Error values", () => {
    expect(sanitizeErrorForDisplay("string")).toBe("An unexpected error occurred");
    expect(sanitizeErrorForDisplay(null)).toBe("An unexpected error occurred");
    expect(sanitizeErrorForDisplay(undefined)).toBe("An unexpected error occurred");
    expect(sanitizeErrorForDisplay(42)).toBe("An unexpected error occurred");
  });

  test("returns custom fallback for non-Error values", () => {
    expect(sanitizeErrorForDisplay("oops", "Custom")).toBe("Custom");
  });

  test("returns error message for Error instances", () => {
    expect(sanitizeErrorForDisplay(new Error("Connection failed"))).toBe("Connection failed");
  });

  test("strips Unix file paths", () => {
    const err = new Error("Error in /usr/local/src/module.ts: bad");
    const result = sanitizeErrorForDisplay(err);
    expect(result).toContain("[path]");
    expect(result).not.toContain("/usr/local/src/module.ts");
  });

  test("strips Windows file paths", () => {
    const err = new Error("Error in C:\\Users\\app\\main.js: bad");
    const result = sanitizeErrorForDisplay(err);
    expect(result).toContain("[path]");
    expect(result).not.toContain("C:\\Users");
  });

  test("strips stack traces", () => {
    const err = new Error("Fail\n    at Object.run (/src/runner.ts:5:3)");
    expect(sanitizeErrorForDisplay(err)).toBe("Fail");
  });

  test("returns fallback for empty Error message", () => {
    expect(sanitizeErrorForDisplay(new Error(""))).toBe("An unexpected error occurred");
  });
});
