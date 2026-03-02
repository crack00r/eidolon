import { describe, expect, test } from "bun:test";
import { formatCheck, formatTable } from "../utils/formatter.js";

// ---------------------------------------------------------------------------
// formatCheck
// ---------------------------------------------------------------------------

describe("formatCheck", () => {
  test("returns [PASS] prefix for pass status", () => {
    const result = formatCheck("pass", "Bun runtime v1.2.0");
    expect(result).toBe("[PASS] Bun runtime v1.2.0");
  });

  test("returns [FAIL] prefix for fail status", () => {
    const result = formatCheck("fail", "Claude Code CLI not installed");
    expect(result).toBe("[FAIL] Claude Code CLI not installed");
  });

  test("returns [WARN] prefix for warn status", () => {
    const result = formatCheck("warn", "Master key not set");
    expect(result).toBe("[WARN] Master key not set");
  });

  test("handles empty message", () => {
    const result = formatCheck("pass", "");
    expect(result).toBe("[PASS] ");
  });

  test("preserves special characters in message", () => {
    const result = formatCheck("pass", "Path: /home/user/.config/eidolon (mode 0600)");
    expect(result).toBe("[PASS] Path: /home/user/.config/eidolon (mode 0600)");
  });
});

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe("formatTable", () => {
  test("returns '(no data)' for empty rows", () => {
    const result = formatTable([], ["Name", "Value"]);
    expect(result).toBe("(no data)");
  });

  test("formats a single-row table with header and separator", () => {
    const rows = [{ Key: "api-key", Value: "sk-test" }];
    const result = formatTable(rows, ["Key", "Value"]);
    const lines = result.split("\n");

    expect(lines).toHaveLength(3); // header + separator + 1 data row
    expect(lines[0]).toContain("Key");
    expect(lines[0]).toContain("Value");
    // Separator line should only contain dashes and spaces
    expect(lines[1]).toMatch(/^[-\s]+$/);
    expect(lines[2]).toContain("api-key");
    expect(lines[2]).toContain("sk-test");
  });

  test("formats multiple rows", () => {
    const rows = [
      { Name: "alice", Age: "30" },
      { Name: "bob", Age: "25" },
      { Name: "charlie", Age: "35" },
    ];
    const result = formatTable(rows, ["Name", "Age"]);
    const lines = result.split("\n");

    expect(lines).toHaveLength(5); // header + separator + 3 data rows
    expect(lines[2]).toContain("alice");
    expect(lines[3]).toContain("bob");
    expect(lines[4]).toContain("charlie");
  });

  test("aligns columns based on longest value", () => {
    const rows = [
      { Key: "a", Description: "short" },
      { Key: "long-key-name", Description: "x" },
    ];
    const result = formatTable(rows, ["Key", "Description"]);
    const lines = result.split("\n");

    // Header "Key" column should be padded to at least "long-key-name" width (13)
    // Both data lines should start at the same position for Description
    const headerDescStart = lines[0]?.indexOf("Description") ?? -1;
    const row1DescStart = lines[2]?.indexOf("short") ?? -1;
    const row2DescStart = lines[3]?.indexOf("x") ?? -1;

    // All Description values should be aligned
    expect(headerDescStart).toBeGreaterThan(0);
    expect(row1DescStart).toBe(headerDescStart);
    expect(row2DescStart).toBe(headerDescStart);
  });

  test("handles missing values in rows gracefully", () => {
    const rows: Record<string, string>[] = [
      { Key: "test-key", Description: "has description" },
      { Key: "other-key" }, // missing Description
    ];
    const result = formatTable(rows, ["Key", "Description"]);
    const lines = result.split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("has description");
    // Missing value should be treated as empty string, not crash
    expect(lines[3]).toContain("other-key");
  });

  test("column width respects header length for short data", () => {
    const rows = [{ LongHeaderName: "x" }];
    const result = formatTable(rows, ["LongHeaderName"]);
    const lines = result.split("\n");

    // Header should not be truncated
    expect(lines[0]?.trim()).toBe("LongHeaderName");
    // Separator should be at least as long as the header
    expect(lines[1]?.trim().length).toBeGreaterThanOrEqual("LongHeaderName".length);
  });

  test("separator line matches column widths", () => {
    const rows = [{ A: "hello", B: "world" }];
    const result = formatTable(rows, ["A", "B"]);
    const lines = result.split("\n");

    // Separator segments should be dashes matching column widths
    const separatorParts = lines[1]?.split("  ") ?? [];
    expect(separatorParts.every((part) => /^-+$/.test(part))).toBe(true);
  });

  test("handles columns not present in data", () => {
    const rows = [{ A: "value" }];
    // Requesting column "B" that doesn't exist in data
    const result = formatTable(rows, ["A", "B"]);
    const lines = result.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("A");
    expect(lines[0]).toContain("B");
  });

  test("columns use double-space separator", () => {
    const rows = [{ Col1: "a", Col2: "b" }];
    const result = formatTable(rows, ["Col1", "Col2"]);

    // The columns are joined with "  " (double space)
    expect(result).toContain("  ");
  });
});
