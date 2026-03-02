/**
 * Integration tests for daemon module wiring.
 *
 * Tests the individual modules that the daemon orchestrates (DatabaseManager,
 * EventBus, TokenTracker, HealthChecker) without calling EidolonDaemon.start()
 * which requires the full file system / config setup.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseConfig, TokenUsage } from "@eidolon/protocol";
import { DatabaseManager } from "../../database/manager.ts";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import { HealthChecker } from "../../health/checker.ts";
import { createBunCheck, createConfigCheck } from "../../health/checks/index.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { TokenTracker } from "../../metrics/token-tracker.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeDbConfig(dir: string): DatabaseConfig {
  return {
    directory: dir,
    walMode: true,
    backupSchedule: "0 3 * * *",
  };
}

/** Create an in-memory operational database with all migrations applied. */
function createInMemoryOperationalDb(logger: Logger): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
  if (!result.ok) {
    throw new Error(`Failed to run migrations: ${result.error.message}`);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Daemon lifecycle integration", () => {
  const logger = createSilentLogger();

  // Track resources for cleanup
  const tempDirs: string[] = [];
  const managers: DatabaseManager[] = [];
  const databases: Database[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-daemon-test-"));
    tempDirs.push(dir);
    return dir;
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

    for (const db of databases) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    databases.length = 0;

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. DatabaseManager initializes all 3 databases with migrations
  // -------------------------------------------------------------------------

  describe("DatabaseManager initializes all 3 databases with migrations", () => {
    test("creates memory, operational, and audit databases that are writable", () => {
      const dir = makeTempDir();
      const mgr = new DatabaseManager(makeDbConfig(dir), logger);
      managers.push(mgr);

      const result = mgr.initialize();
      expect(result.ok).toBe(true);

      // Verify memory DB is writable -- insert a test row
      mgr.memory
        .query(
          `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("test-mem-1", "fact", "long_term", "test content", 0.9, "test", "[]", Date.now(), Date.now(), Date.now());

      const memRow = mgr.memory.query("SELECT id, content FROM memories WHERE id = ?").get("test-mem-1") as {
        id: string;
        content: string;
      } | null;
      expect(memRow).not.toBeNull();
      expect(memRow?.id).toBe("test-mem-1");
      expect(memRow?.content).toBe("test content");

      // Verify operational DB is writable -- insert a test session
      mgr.operational
        .query(
          `INSERT INTO sessions (id, type, status, started_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("test-sess-1", "main", "running", Date.now(), Date.now());

      const opRow = mgr.operational.query("SELECT id FROM sessions WHERE id = ?").get("test-sess-1") as {
        id: string;
      } | null;
      expect(opRow).not.toBeNull();
      expect(opRow?.id).toBe("test-sess-1");

      // Verify audit DB is writable -- insert a test audit log entry
      mgr.audit
        .query(
          `INSERT INTO audit_log (id, timestamp, actor, action, target, result, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("test-audit-1", Date.now(), "system", "test_action", "daemon", "success", "{}");

      const auditRow = mgr.audit.query("SELECT id FROM audit_log WHERE id = ?").get("test-audit-1") as {
        id: string;
      } | null;
      expect(auditRow).not.toBeNull();
      expect(auditRow?.id).toBe("test-audit-1");
    });
  });

  // -------------------------------------------------------------------------
  // 2. EventBus round-trip: publish and dequeue
  // -------------------------------------------------------------------------

  describe("EventBus round-trip: publish and dequeue", () => {
    test("published event can be dequeued with matching data", () => {
      const db = createInMemoryOperationalDb(logger);
      databases.push(db);

      const bus = new EventBus(db, logger);
      const payload = { channelId: "telegram", userId: "user-1", text: "Hello Eidolon" };

      const pubResult = bus.publish("user:message", payload, {
        priority: "normal",
        source: "test",
      });
      expect(pubResult.ok).toBe(true);
      if (!pubResult.ok) return;

      const publishedEvent = pubResult.value;
      expect(publishedEvent.type).toBe("user:message");
      expect(publishedEvent.priority).toBe("normal");
      expect(publishedEvent.source).toBe("test");
      expect(publishedEvent.payload).toEqual(payload);

      // Dequeue should return the same event
      const deqResult = bus.dequeue();
      expect(deqResult.ok).toBe(true);
      if (!deqResult.ok) return;

      const dequeued = deqResult.value;
      expect(dequeued).not.toBeNull();
      expect(dequeued?.id).toBe(publishedEvent.id);
      expect(dequeued?.type).toBe("user:message");
      expect(dequeued?.payload).toEqual(payload);

      // After marking processed, dequeue returns null
      if (!dequeued) throw new Error("Expected dequeued event");
      bus.markProcessed(dequeued.id);
      const emptyResult = bus.dequeue();
      expect(emptyResult.ok).toBe(true);
      if (!emptyResult.ok) return;
      expect(emptyResult.value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. EventBus persists events across restarts
  // -------------------------------------------------------------------------

  describe("EventBus persists events across restarts", () => {
    test("event survives EventBus destruction and recreation with same DB", () => {
      const testDir = makeTempDir();
      const dbPath = join(testDir, "operational-persist.db");
      const payload = { message: "persist me" };

      // Phase 1: create DB, publish event, then close
      {
        const db = new Database(dbPath, { create: true });
        db.exec("PRAGMA journal_mode=WAL");
        db.exec("PRAGMA foreign_keys=ON");
        const migResult = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
        expect(migResult.ok).toBe(true);

        const bus = new EventBus(db, logger);
        const pubResult = bus.publish("system:startup", payload, { source: "test" });
        expect(pubResult.ok).toBe(true);

        // Checkpoint WAL to ensure data is in the main db file
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
      }

      // Phase 2: reopen same DB file, create new EventBus, dequeue
      {
        const db2 = new Database(dbPath);
        databases.push(db2);
        db2.exec("PRAGMA journal_mode=WAL");
        db2.exec("PRAGMA foreign_keys=ON");

        const bus2 = new EventBus(db2, logger);
        const deqResult = bus2.dequeue();
        expect(deqResult.ok).toBe(true);
        if (!deqResult.ok) return;

        const dequeued = deqResult.value;
        expect(dequeued).not.toBeNull();
        expect(dequeued?.type).toBe("system:startup");
        expect(dequeued?.payload).toEqual(payload);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. TokenTracker records and aggregates usage
  // -------------------------------------------------------------------------

  describe("TokenTracker records and aggregates usage", () => {
    test("records usage for 2 sessions and aggregates correctly", () => {
      const db = createInMemoryOperationalDb(logger);
      databases.push(db);

      const tracker = new TokenTracker(db, logger);
      const now = Date.now();

      const usage1: TokenUsage = {
        sessionId: "sess-alpha",
        sessionType: "main",
        model: "claude-sonnet-4-20250514",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        costUsd: 0.05,
        timestamp: now - 1000,
      };

      const usage2: TokenUsage = {
        sessionId: "sess-beta",
        sessionType: "task",
        model: "claude-sonnet-4-20250514",
        inputTokens: 2000,
        outputTokens: 800,
        cacheReadTokens: 300,
        cacheWriteTokens: 150,
        costUsd: 0.08,
        timestamp: now - 500,
      };

      const rec1 = tracker.record(usage1);
      expect(rec1.ok).toBe(true);

      const rec2 = tracker.record(usage2);
      expect(rec2.ok).toBe(true);

      // Verify aggregation via getSummary
      const summaryResult = tracker.getSummary("hour");
      expect(summaryResult.ok).toBe(true);
      if (!summaryResult.ok) return;

      const summary = summaryResult.value;
      expect(summary.period).toBe("hour");
      expect(summary.totalCostUsd).toBeCloseTo(0.13, 5);
      expect(summary.totalInputTokens).toBe(3000);
      expect(summary.totalOutputTokens).toBe(1300);

      // Verify by session type
      expect(summary.bySessionType.main).toBeCloseTo(0.05, 5);
      expect(summary.bySessionType.task).toBeCloseTo(0.08, 5);

      // Verify by model
      expect(summary.byModel["claude-sonnet-4-20250514"]).toBeCloseTo(0.13, 5);

      // Verify per-session query
      const sessResult = tracker.getSessionUsage("sess-alpha");
      expect(sessResult.ok).toBe(true);
      if (!sessResult.ok) return;

      expect(sessResult.value).toHaveLength(1);
      expect(sessResult.value[0]?.inputTokens).toBe(1000);
      expect(sessResult.value[0]?.outputTokens).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // 5. HealthChecker with real checks returns correct status
  // -------------------------------------------------------------------------

  describe("HealthChecker with real checks returns correct status", () => {
    test("bun and config checks both pass on valid setup", async () => {
      const checker = new HealthChecker(logger);

      // Register the bun runtime check (always passes on Bun >= 1.0)
      checker.register("bun", createBunCheck());

      // Create a valid JSON config file for the config check
      const testDir = makeTempDir();
      const configPath = join(testDir, "config.json");
      await Bun.write(configPath, JSON.stringify({ daemon: { enabled: true } }));
      checker.register("config", createConfigCheck(configPath));

      const status = await checker.check();

      expect(status.status).toBe("healthy");
      expect(status.checks).toHaveLength(2);
      expect(status.uptime).toBeGreaterThanOrEqual(0);
      expect(status.timestamp).toBeGreaterThan(0);

      // Verify individual check results
      const bunCheck = status.checks.find((c) => c.name === "bun");
      expect(bunCheck).toBeDefined();
      expect(bunCheck?.status).toBe("pass");
      expect(bunCheck?.message).toContain("Bun v");

      const configCheck = status.checks.find((c) => c.name === "config");
      expect(configCheck).toBeDefined();
      expect(configCheck?.status).toBe("pass");
      expect(configCheck?.message).toBe("Config file valid");
    });

    test("missing config file produces warn status (degraded)", async () => {
      const checker = new HealthChecker(logger);

      checker.register("bun", createBunCheck());
      checker.register("config", createConfigCheck("/nonexistent/path/config.json"));

      const status = await checker.check();

      // bun passes, config warns -> degraded
      expect(status.status).toBe("degraded");

      const configCheck = status.checks.find((c) => c.name === "config");
      expect(configCheck?.status).toBe("warn");
    });
  });
});
