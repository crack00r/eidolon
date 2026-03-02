import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseConfig } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { DatabaseManager } from "../manager.ts";

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

describe("DatabaseManager", () => {
  const logger = createSilentLogger();
  const tempDirs: string[] = [];
  const managers: DatabaseManager[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-mgr-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function makeConfig(dir: string): DatabaseConfig {
    return {
      directory: dir,
      walMode: true,
      backupSchedule: "0 3 * * *",
    };
  }

  function makeManager(dir: string): DatabaseManager {
    const mgr = new DatabaseManager(makeConfig(dir), logger);
    managers.push(mgr);
    return mgr;
  }

  afterEach(() => {
    for (const mgr of managers) {
      try {
        mgr.close();
      } catch {
        // already closed
      }
    }
    managers.length = 0;

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("throws when accessing databases before initialize()", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    expect(() => mgr.memory).toThrow("not initialized");
    expect(() => mgr.operational).toThrow("not initialized");
    expect(() => mgr.audit).toThrow("not initialized");
  });

  test("initialize creates all 3 databases with correct schemas", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    const result = mgr.initialize();

    expect(result.ok).toBe(true);
    expect(mgr.memory).toBeDefined();
    expect(mgr.operational).toBeDefined();
    expect(mgr.audit).toBeDefined();
  });

  test("memory database has memories table", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr.initialize();

    const tables = mgr.memory
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_*'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_edges");
    expect(tableNames).toContain("kg_entities");
    expect(tableNames).toContain("kg_relations");
    expect(tableNames).toContain("kg_communities");
    expect(tableNames).toContain("kg_complex_embeddings");
  });

  test("operational database has sessions, events, token_usage tables", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr.initialize();

    const tables = mgr.operational
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_*'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("events");
    expect(tableNames).toContain("token_usage");
    expect(tableNames).toContain("loop_state");
    expect(tableNames).toContain("scheduled_tasks");
    expect(tableNames).toContain("discoveries");
    expect(tableNames).toContain("circuit_breakers");
    expect(tableNames).toContain("account_usage");
  });

  test("audit database has audit_log table", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr.initialize();

    const tables = mgr.audit
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_*'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("audit_log");
  });

  test("close() closes all connections", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr.initialize();

    mgr.close();

    // After close, accessing databases should throw
    expect(() => mgr.memory).toThrow("not initialized");
    expect(() => mgr.operational).toThrow("not initialized");
    expect(() => mgr.audit).toThrow("not initialized");
  });

  test("getStats() returns correct table counts", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr.initialize();

    const stats = mgr.getStats();

    // Memory: memories, memory_edges, kg_entities, kg_relations, kg_communities, kg_complex_embeddings
    // (memories_fts is virtual, not counted by our query)
    expect(stats.memory.tableCount).toBeGreaterThanOrEqual(6);
    expect(stats.memory.path).toContain("memory.db");

    // Operational: sessions, events, loop_state, token_usage, scheduled_tasks,
    // discoveries, circuit_breakers, account_usage + sqlite_sequence (from AUTOINCREMENT)
    expect(stats.operational.tableCount).toBeGreaterThanOrEqual(8);
    expect(stats.operational.path).toContain("operational.db");

    // Audit: audit_log
    expect(stats.audit.tableCount).toBeGreaterThanOrEqual(1);
    expect(stats.audit.path).toContain("audit.db");
  });

  test("initialize is idempotent (can be called twice safely)", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);

    const first = mgr.initialize();
    expect(first.ok).toBe(true);

    // Close and reinitialize
    mgr.close();
    const second = mgr.initialize();
    expect(second.ok).toBe(true);
  });

  test("memory database supports FTS5 search", () => {
    const dir = makeTempDir();
    const mgr = makeManager(dir);
    mgr.initialize();

    // Insert a memory
    mgr.memory
      .query(
        `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("m1", "fact", "long_term", "TypeScript is a typed superset of JavaScript", 0.9, "test", "[]", 1, 1, 1);

    // FTS5 search
    const results = mgr.memory
      .query("SELECT content FROM memories_fts WHERE memories_fts MATCH ?")
      .all("TypeScript") as Array<{ content: string }>;

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("TypeScript");
  });
});
