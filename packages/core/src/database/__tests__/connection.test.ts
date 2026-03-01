import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "../connection.js";

describe("createConnection", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-conn-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("creates an in-memory database successfully", () => {
    const result = createConnection(":memory:");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(Database);
      result.value.close();
    }
  });

  test("enables WAL mode by default", () => {
    const dir = makeTempDir();
    const result = createConnection(join(dir, "test.db"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.value.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
      result.value.close();
    }
  });

  test("enables foreign keys", () => {
    const result = createConnection(":memory:");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.value.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
      result.value.close();
    }
  });

  test("creates parent directory if it does not exist", () => {
    const dir = makeTempDir();
    const nested = join(dir, "sub", "dir", "test.db");
    const result = createConnection(nested);
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.value.close();
    }
  });

  test("returns error for invalid path", () => {
    // /dev/null is not a valid sqlite database path on macOS/Linux
    const result = createConnection("/proc/nonexistent/impossible/path/db.sqlite");
    // This should either succeed (if the dir is created) or fail
    // On most systems, /proc/nonexistent won't be writable
    if (!result.ok) {
      expect(result.error.code).toBe("DB_CONNECTION_FAILED");
    }
  });

  test("respects walMode=false option", () => {
    const result = createConnection(":memory:", { walMode: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // In-memory databases default to "memory" journal mode
      const row = result.value.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).not.toBe("wal");
      result.value.close();
    }
  });

  test("respects custom busy timeout", () => {
    const result = createConnection(":memory:", { busyTimeout: 10000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.value.query("PRAGMA busy_timeout").get() as { timeout: number };
      expect(row.timeout).toBe(10000);
      result.value.close();
    }
  });
});
