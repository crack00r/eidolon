import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabases } from "../setup-database.ts";

describe("initializeDatabases", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "eidolon-db-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates all 3 databases and returns table counts", () => {
    const result = initializeDatabases(tempDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoryTables).toBeGreaterThan(0);
    expect(result.value.operationalTables).toBeGreaterThan(0);
    expect(result.value.auditTables).toBeGreaterThan(0);
  });

  test("returns error for invalid directory", () => {
    const result = initializeDatabases("/nonexistent/path/that/cannot/exist");
    expect(result.ok).toBe(false);
  });
});
