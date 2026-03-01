/**
 * Output formatting helpers for the CLI.
 */

type CheckStatus = "pass" | "fail" | "warn";

const CHECK_ICONS: Record<CheckStatus, string> = {
  pass: "[PASS]",
  fail: "[FAIL]",
  warn: "[WARN]",
};

/** Print a status line: [PASS], [FAIL], [WARN] */
export function formatCheck(status: CheckStatus, message: string): string {
  return `${CHECK_ICONS[status]} ${message}`;
}

/** Format a table for terminal output with aligned columns. */
export function formatTable(rows: ReadonlyArray<Record<string, string>>, columns: readonly string[]): string {
  if (rows.length === 0) return "(no data)";

  // Calculate column widths
  const widths = new Map<string, number>();
  for (const col of columns) {
    const headerLen = col.length;
    const maxDataLen = Math.max(...rows.map((r) => (r[col] ?? "").length));
    widths.set(col, Math.max(headerLen, maxDataLen));
  }

  // Header
  const header = columns.map((col) => col.padEnd(widths.get(col) ?? 0)).join("  ");
  const separator = columns.map((col) => "-".repeat(widths.get(col) ?? 0)).join("  ");

  // Rows
  const dataLines = rows.map((row) => columns.map((col) => (row[col] ?? "").padEnd(widths.get(col) ?? 0)).join("  "));

  return [header, separator, ...dataLines].join("\n");
}
