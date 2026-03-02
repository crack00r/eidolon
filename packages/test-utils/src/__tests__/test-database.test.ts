import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createTestDatabaseDir } from "../test-database.ts";

describe("createTestDatabaseDir", () => {
  test("creates directory with correct paths", () => {
    const testDb = createTestDatabaseDir();

    try {
      expect(existsSync(testDb.directory)).toBe(true);
      expect(testDb.memoryPath).toContain("memory.db");
      expect(testDb.operationalPath).toContain("operational.db");
      expect(testDb.auditPath).toContain("audit.db");
      expect(testDb.memoryPath).toContain(testDb.directory);
      expect(testDb.operationalPath).toContain(testDb.directory);
      expect(testDb.auditPath).toContain(testDb.directory);
    } finally {
      testDb.cleanup();
    }
  });

  test("cleanup removes the directory", () => {
    const testDb = createTestDatabaseDir();
    const dir = testDb.directory;

    expect(existsSync(dir)).toBe(true);
    testDb.cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  test("accepts custom prefix", () => {
    const testDb = createTestDatabaseDir("custom-prefix-");

    try {
      expect(testDb.directory).toContain("custom-prefix-");
    } finally {
      testDb.cleanup();
    }
  });
});
