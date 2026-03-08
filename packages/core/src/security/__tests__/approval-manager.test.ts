import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { SecurityConfig } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { ApprovalManager } from "../approval-manager.ts";

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

function createTestDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error("Failed to run migrations");
  return db;
}

function createTestConfig(overrides?: Partial<SecurityConfig["approval"]>): SecurityConfig {
  return {
    policies: {
      shellExecution: "needs_approval",
      fileModification: "needs_approval",
      networkAccess: "safe",
      secretAccess: "dangerous",
    },
    approval: {
      timeout: 5_000,
      defaultAction: "deny",
      escalation: [],
      checkIntervalMs: 60_000, // long interval so timer doesn't fire in tests
      ...overrides,
    },
    sandbox: {
      enabled: false,
      runtime: "none",
    },
    audit: {
      enabled: true,
      retentionDays: 365,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApprovalManager", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];
  const managers: ApprovalManager[] = [];

  function makeManager(configOverrides?: Partial<SecurityConfig["approval"]>): {
    manager: ApprovalManager;
    eventBus: EventBus;
    db: Database;
  } {
    const db = createTestDb();
    databases.push(db);
    const eventBus = new EventBus(db, logger);
    const config = createTestConfig(configOverrides);
    const manager = new ApprovalManager({ db, logger, eventBus, config });
    managers.push(manager);
    return { manager, eventBus, db };
  }

  afterEach(() => {
    for (const mgr of managers) {
      mgr.stop();
    }
    managers.length = 0;
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  // -------------------------------------------------------------------------
  // requestApproval()
  // -------------------------------------------------------------------------

  describe("requestApproval", () => {
    test("creates a pending approval request", () => {
      const { manager } = makeManager();

      const result = manager.requestApproval({
        action: "shell_exec",
        level: "needs_approval",
        description: "Run npm install",
        channel: "telegram",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.action).toBe("shell_exec");
      expect(result.value.level).toBe("needs_approval");
      expect(result.value.description).toBe("Run npm install");
      expect(result.value.channel).toBe("telegram");
      expect(result.value.status).toBe("pending");
      expect(result.value.escalationLevel).toBe(0);
      expect(result.value.id).toBeTruthy();
      expect(result.value.requestedAt).toBeGreaterThan(0);
      expect(result.value.timeoutAt).toBeGreaterThan(result.value.requestedAt);
    });

    test("persists request to database", () => {
      const { manager, db } = makeManager();

      const result = manager.requestApproval({
        action: "file_write",
        level: "safe",
        description: "Write to config",
        channel: "desktop",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const row = db.query("SELECT * FROM approval_requests WHERE id = ?").get(result.value.id) as {
        id: string;
        status: string;
      } | null;
      expect(row).not.toBeNull();
      expect(row?.status).toBe("pending");
    });

    test("emits approval:requested event", () => {
      const { manager, eventBus } = makeManager();
      const events: Array<{ type: string }> = [];
      eventBus.subscribe("approval:requested", (event) => {
        events.push(event);
      });

      manager.requestApproval({
        action: "deploy",
        level: "dangerous",
        description: "Deploy to production",
        channel: "telegram",
      });

      expect(events.length).toBe(1);
    });

    test("stores metadata when provided", () => {
      const { manager } = makeManager();

      const result = manager.requestApproval({
        action: "install_dep",
        level: "needs_approval",
        description: "Install lodash",
        channel: "cli",
        metadata: { package: "lodash", version: "4.17.21" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.metadata).toEqual({ package: "lodash", version: "4.17.21" });
    });
  });

  // -------------------------------------------------------------------------
  // respond()
  // -------------------------------------------------------------------------

  describe("respond", () => {
    test("approves a pending request", () => {
      const { manager } = makeManager();
      const req = manager.requestApproval({
        action: "shell_exec",
        level: "needs_approval",
        description: "Run build",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      const result = manager.respond({
        requestId: req.value.id,
        approved: true,
        respondedBy: "user:manuel",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("approved");
      expect(result.value.respondedBy).toBe("user:manuel");
      expect(result.value.respondedAt).toBeGreaterThan(0);
    });

    test("denies a pending request", () => {
      const { manager } = makeManager();
      const req = manager.requestApproval({
        action: "delete_files",
        level: "dangerous",
        description: "Delete temp files",
        channel: "desktop",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      const result = manager.respond({
        requestId: req.value.id,
        approved: false,
        respondedBy: "user:manuel",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("denied");
    });

    test("returns error for non-existent request", () => {
      const { manager } = makeManager();
      const result = manager.respond({
        requestId: "non-existent-id",
        approved: true,
        respondedBy: "user:manuel",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("APPROVAL_NOT_FOUND");
    });

    test("returns error for already-resolved request", () => {
      const { manager } = makeManager();
      const req = manager.requestApproval({
        action: "shell_exec",
        level: "needs_approval",
        description: "Run test",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      // Approve it first
      manager.respond({ requestId: req.value.id, approved: true, respondedBy: "user:manuel" });

      // Try to respond again
      const result = manager.respond({
        requestId: req.value.id,
        approved: false,
        respondedBy: "user:manuel",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("APPROVAL_ALREADY_RESOLVED");
    });
  });

  // -------------------------------------------------------------------------
  // checkTimeouts() -- auto-deny
  // -------------------------------------------------------------------------

  describe("checkTimeouts", () => {
    test("auto-denies timed-out requests with deny policy", () => {
      const { manager, db } = makeManager({ timeout: 1, defaultAction: "deny" });

      const req = manager.requestApproval({
        action: "shell_exec",
        level: "needs_approval",
        description: "Run command",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      // Force timeout by updating timeout_at to the past
      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, req.value.id);

      const processed = manager.checkTimeouts();
      expect(processed).toBe(1);

      const updated = manager.getById(req.value.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value?.status).toBe("denied");
      expect(updated.value?.respondedBy).toBe("auto:timeout:denied");
    });

    test("auto-approves timed-out safe requests with allow policy", () => {
      const { manager, db } = makeManager({ timeout: 1, defaultAction: "allow" });

      const req = manager.requestApproval({
        action: "read_file",
        level: "safe",
        description: "Read config",
        channel: "desktop",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, req.value.id);

      const processed = manager.checkTimeouts();
      expect(processed).toBe(1);

      const updated = manager.getById(req.value.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value?.status).toBe("approved");
      expect(updated.value?.respondedBy).toBe("auto:timeout:approved");
    });

    test("never auto-approves dangerous actions even with allow policy", () => {
      const { manager, db } = makeManager({ timeout: 1, defaultAction: "allow" });

      const req = manager.requestApproval({
        action: "delete_db",
        level: "dangerous",
        description: "Delete database",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, req.value.id);

      manager.checkTimeouts();

      const updated = manager.getById(req.value.id);
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value?.status).toBe("denied");
      // Should be auto:timeout:denied despite allow policy because action is dangerous
      expect(updated.value?.respondedBy).toBe("auto:timeout:denied");
    });

    test("does not process requests that have not timed out", () => {
      const { manager } = makeManager({ timeout: 300_000 });

      manager.requestApproval({
        action: "shell_exec",
        level: "needs_approval",
        description: "Run command",
        channel: "telegram",
      });

      const processed = manager.checkTimeouts();
      expect(processed).toBe(0);
    });

    test("emits approval:timeout event", () => {
      const { manager, eventBus, db } = makeManager({ timeout: 1, defaultAction: "deny" });
      const events: Array<{ type: string }> = [];
      eventBus.subscribe("approval:timeout", (event) => {
        events.push(event);
      });

      const req = manager.requestApproval({
        action: "shell_exec",
        level: "needs_approval",
        description: "Run command",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, req.value.id);
      manager.checkTimeouts();

      expect(events.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  describe("escalation", () => {
    test("escalates to next channel in escalation chain", () => {
      const { manager, db } = makeManager({
        escalation: [
          { timeoutMs: 1, action: "escalate", escalateTo: "desktop", maxEscalations: 3 },
          { timeoutMs: 5000, action: "deny", maxEscalations: 3 },
        ],
      });

      const req = manager.requestApproval({
        action: "deploy",
        level: "needs_approval",
        description: "Deploy to staging",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      // Force timeout
      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, req.value.id);

      const processed = manager.checkTimeouts();
      expect(processed).toBe(1);

      // Original should be escalated
      const original = manager.getById(req.value.id);
      expect(original.ok).toBe(true);
      if (!original.ok) return;
      expect(original.value?.status).toBe("escalated");

      // New request should exist at escalation level 1 with new channel
      const pending = manager.list({ status: "pending" });
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value.length).toBe(1);
      expect(pending.value[0]?.channel).toBe("desktop");
      expect(pending.value[0]?.escalationLevel).toBe(1);
    });

    test("emits approval:escalated event", () => {
      const { manager, eventBus, db } = makeManager({
        escalation: [{ timeoutMs: 1, action: "escalate", escalateTo: "desktop", maxEscalations: 3 }],
      });

      const events: Array<{ type: string }> = [];
      eventBus.subscribe("approval:escalated", (event) => {
        events.push(event);
      });

      const req = manager.requestApproval({
        action: "deploy",
        level: "needs_approval",
        description: "Deploy",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, req.value.id);
      manager.checkTimeouts();

      expect(events.length).toBe(1);
    });

    test("applies default action when max escalations reached", () => {
      const { manager, db } = makeManager({
        defaultAction: "deny",
        escalation: [{ timeoutMs: 1, action: "escalate", escalateTo: "desktop", maxEscalations: 1 }],
      });

      const req = manager.requestApproval({
        action: "deploy",
        level: "needs_approval",
        description: "Deploy",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      // Force timeout on original -> escalates to level 1
      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, req.value.id);
      manager.checkTimeouts();

      // Get the escalated request at level 1
      const pending = manager.list({ status: "pending" });
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value.length).toBe(1);
      const escalatedReq = pending.value[0]!;
      expect(escalatedReq.escalationLevel).toBe(1);

      // Force timeout on escalated request -> should hit max escalations
      db.query("UPDATE approval_requests SET timeout_at = ? WHERE id = ?").run(Date.now() - 1000, escalatedReq.id);

      // Level 1 with maxEscalations=1 means nextLevel (2) > maxEscalations (1),
      // so it should apply the default action (deny)
      manager.checkTimeouts();

      const resolved = manager.getById(escalatedReq.id);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value?.status).toBe("denied");
      expect(resolved.value?.respondedBy).toContain("max_escalation");
    });
  });

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

  describe("query methods", () => {
    test("getById returns null for non-existent request", () => {
      const { manager } = makeManager();
      const result = manager.getById("non-existent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    test("list returns pending requests by default", () => {
      const { manager } = makeManager();
      manager.requestApproval({
        action: "action-1",
        level: "safe",
        description: "desc-1",
        channel: "telegram",
      });
      manager.requestApproval({
        action: "action-2",
        level: "needs_approval",
        description: "desc-2",
        channel: "desktop",
      });

      const result = manager.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    test("list filters by status", () => {
      const { manager } = makeManager();
      const req = manager.requestApproval({
        action: "action-1",
        level: "safe",
        description: "desc-1",
        channel: "telegram",
      });
      expect(req.ok).toBe(true);
      if (!req.ok) return;

      // Approve one request
      manager.respond({ requestId: req.value.id, approved: true, respondedBy: "user:test" });

      // Create another pending
      manager.requestApproval({
        action: "action-2",
        level: "needs_approval",
        description: "desc-2",
        channel: "desktop",
      });

      const approved = manager.list({ status: "approved" });
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.value.length).toBe(1);

      const pending = manager.list({ status: "pending" });
      expect(pending.ok).toBe(true);
      if (!pending.ok) return;
      expect(pending.value.length).toBe(1);
    });

    test("list respects limit", () => {
      const { manager } = makeManager();
      for (let i = 0; i < 10; i++) {
        manager.requestApproval({
          action: `action-${i}`,
          level: "safe",
          description: `desc-${i}`,
          channel: "telegram",
        });
      }

      const result = manager.list({ limit: 3 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
    });

    test("pendingCount returns correct count", () => {
      const { manager } = makeManager();
      manager.requestApproval({
        action: "action-1",
        level: "safe",
        description: "desc-1",
        channel: "telegram",
      });
      manager.requestApproval({
        action: "action-2",
        level: "needs_approval",
        description: "desc-2",
        channel: "desktop",
      });

      const result = manager.pendingCount();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    test("start and stop do not throw", () => {
      const { manager } = makeManager();
      expect(() => manager.start()).not.toThrow();
      expect(() => manager.stop()).not.toThrow();
    });

    test("stop is idempotent", () => {
      const { manager } = makeManager();
      manager.start();
      expect(() => manager.stop()).not.toThrow();
      expect(() => manager.stop()).not.toThrow();
    });
  });
});
