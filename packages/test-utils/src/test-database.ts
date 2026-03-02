/**
 * Test helper for creating temporary database directories.
 *
 * Creates a temp directory with paths for all 3 databases (memory, operational, audit).
 * Provides cleanup() to remove everything after tests complete.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestDatabaseDir {
  readonly directory: string;
  readonly memoryPath: string;
  readonly operationalPath: string;
  readonly auditPath: string;
  cleanup(): void;
}

/**
 * Create a temporary directory with database paths for testing.
 *
 * @param prefix - Temp directory prefix (default: "eidolon-test-")
 * @returns TestDatabaseDir with paths and cleanup function
 */
export function createTestDatabaseDir(prefix = "eidolon-test-"): TestDatabaseDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    directory: dir,
    memoryPath: join(dir, "memory.db"),
    operationalPath: join(dir, "operational.db"),
    auditPath: join(dir, "audit.db"),
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
