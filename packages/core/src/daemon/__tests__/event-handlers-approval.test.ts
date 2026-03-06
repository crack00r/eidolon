/**
 * Tests for user:approval event handler wiring.
 *
 * Verifies that user:approval events from the EventBus are forwarded to
 * ApprovalManager, denied actions are logged to audit, and edge cases
 * (invalid payload, missing manager, already resolved) are handled.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { BusEvent, SecurityConfig } from "@eidolon/protocol";
import { AuditLogger } from "../../audit/logger.ts";
import { runMigrations } from "../../database/migrations.ts";
import { AUDIT_MIGRATIONS } from "../../database/schemas/audit.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import type { PriorityScore } from "../../loop/priority.ts";
import { ApprovalManager } from "../../security/approval-manager.ts";
import { buildEventHandler } from "../event-handlers.ts";
import type { InitializedModules } from "../types.ts";

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

function createOperationalDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error(`Failed to run operational migrations: ${result.error.message}`);
  return db;
}

function createAuditDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "audit", AUDIT_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error(`Failed to run audit migrations: ${result.error.message}`);
  return db;
}

function createTestSecurityConfig(overrides?: Partial<SecurityConfig["approval"]>): SecurityConfig {
  return {
    policies: {
      shellExecution: "needs_approval",
      fileModification: "needs_approval",
      networkAccess: "safe",
      secretAccess: "dangerous",
    },
    approval: {
      timeout: 300_000,
      defaultAction: "deny",
      escalation: [],
      checkIntervalMs: 60_000,
      ...overrides,
    },
    sandbox: { enabled: false, runtime: "none" },
    audit: { enabled: true, retentionDays: 365 },
  };
}

const DEFAULT_PRIORITY: PriorityScore = {
  score: 85,
  reason: "test",
  suggestedAction: "execute_task",
  suggestedModel: "fast",
};

function makeApprovalEvent(payload: Record<string, unknown>): BusEvent {
  return {
    id: "evt-approval-test",
    type: "user:approval",
    priority: "high",
    payload,
    timestamp: Date.now(),
    source: "test",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("user:approval event handler", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];
  const managers: ApprovalManager[] = [];

  function setup(configOverrides?: Partial<SecurityConfig["approval"]>): {
    modules: InitializedModules;
    approvalManager: ApprovalManager;
    auditLogger: AuditLogger;
    operationalDb: Database;
    auditDb: Database;
  } {
    const operationalDb = createOperationalDb();
    const auditDb = createAuditDb();
    databases.push(operationalDb, auditDb);

    const eventBus = new EventBus(operationalDb, logger);
    const securityConfig = createTestSecurityConfig(configOverrides);
    const approvalManager = new ApprovalManager({
      db: operationalDb,
      logger,
      eventBus,
      config: securityConfig,
    });
    managers.push(approvalManager);

    const auditLogger = new AuditLogger(auditDb, logger);

    const modules: InitializedModules = {
      logger,
      approvalManager,
      auditLogger,
      eventBus,
    };

    return { modules, approvalManager, auditLogger, operationalDb, auditDb };
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
  // Successful approval
  // -------------------------------------------------------------------------

  test("forwards approve action to ApprovalManager", async () => {
    const { modules, approvalManager } = setup();
    const handler = buildEventHandler(modules);

    // Create a pending approval request
    const reqResult = approvalManager.requestApproval({
      action: "shell_exec",
      level: "needs_approval",
      description: "Run npm install",
      channel: "telegram",
    });
    expect(reqResult.ok).toBe(true);
    if (!reqResult.ok) return;

    const event = makeApprovalEvent({
      approvalId: reqResult.value.id,
      action: "approve",
      respondedBy: "user:manuel",
    });

    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(true);
    expect(result.tokensUsed).toBe(0);

    // Verify the request is now approved in the DB
    const updated = approvalManager.getById(reqResult.value.id);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value?.status).toBe("approved");
    expect(updated.value?.respondedBy).toBe("user:manuel");
  });

  // -------------------------------------------------------------------------
  // Successful denial
  // -------------------------------------------------------------------------

  test("forwards deny action to ApprovalManager", async () => {
    const { modules, approvalManager } = setup();
    const handler = buildEventHandler(modules);

    const reqResult = approvalManager.requestApproval({
      action: "delete_files",
      level: "dangerous",
      description: "Delete temp files",
      channel: "desktop",
    });
    expect(reqResult.ok).toBe(true);
    if (!reqResult.ok) return;

    const event = makeApprovalEvent({
      approvalId: reqResult.value.id,
      action: "deny",
      respondedBy: "user:manuel",
      reason: "Too risky",
    });

    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(true);

    const updated = approvalManager.getById(reqResult.value.id);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value?.status).toBe("denied");
  });

  // -------------------------------------------------------------------------
  // Audit logging
  // -------------------------------------------------------------------------

  test("logs denied actions to audit trail", async () => {
    const { modules, approvalManager, auditDb } = setup();
    const handler = buildEventHandler(modules);

    const reqResult = approvalManager.requestApproval({
      action: "shell_exec",
      level: "needs_approval",
      description: "Run dangerous command",
      channel: "telegram",
    });
    expect(reqResult.ok).toBe(true);
    if (!reqResult.ok) return;

    const event = makeApprovalEvent({
      approvalId: reqResult.value.id,
      action: "deny",
      respondedBy: "user:manuel",
      reason: "Not safe",
    });

    await handler(event, DEFAULT_PRIORITY);

    // Check audit log
    const rows = auditDb.query("SELECT * FROM audit_log WHERE action = 'approval_denied'").all() as Array<{
      actor: string;
      action: string;
      target: string;
      result: string;
      metadata: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.actor).toBe("user:manuel");
    expect(rows[0]?.target).toBe("shell_exec");
    expect(rows[0]?.result).toBe("denied");

    const metadata = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.reason).toBe("Not safe");
    expect(metadata.approvalId).toBe(reqResult.value.id);
  });

  test("logs approved actions to audit trail", async () => {
    const { modules, approvalManager, auditDb } = setup();
    const handler = buildEventHandler(modules);

    const reqResult = approvalManager.requestApproval({
      action: "file_write",
      level: "needs_approval",
      description: "Write config",
      channel: "cli",
    });
    expect(reqResult.ok).toBe(true);
    if (!reqResult.ok) return;

    const event = makeApprovalEvent({
      approvalId: reqResult.value.id,
      action: "approve",
      respondedBy: "user:admin",
    });

    await handler(event, DEFAULT_PRIORITY);

    const rows = auditDb.query("SELECT * FROM audit_log WHERE action = 'approval_granted'").all() as Array<{
      actor: string;
      action: string;
      target: string;
      result: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.actor).toBe("user:admin");
    expect(rows[0]?.target).toBe("file_write");
    expect(rows[0]?.result).toBe("success");
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  test("returns error for missing approvalId", async () => {
    const { modules } = setup();
    const handler = buildEventHandler(modules);

    const event = makeApprovalEvent({ action: "approve" });
    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing approvalId or action");
  });

  test("returns error for missing action", async () => {
    const { modules } = setup();
    const handler = buildEventHandler(modules);

    const event = makeApprovalEvent({ approvalId: "some-id" });
    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing approvalId or action");
  });

  test("returns error for invalid action value", async () => {
    const { modules } = setup();
    const handler = buildEventHandler(modules);

    const event = makeApprovalEvent({
      approvalId: "some-id",
      action: "maybe",
    });
    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid approval action: maybe");
  });

  test("returns error when ApprovalManager is not initialized", async () => {
    const { modules } = setup();
    // Remove the approval manager
    modules.approvalManager = undefined;
    const handler = buildEventHandler(modules);

    const event = makeApprovalEvent({
      approvalId: "some-id",
      action: "approve",
    });
    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(false);
    expect(result.error).toContain("ApprovalManager not initialized");
  });

  test("returns error for non-existent approval request", async () => {
    const { modules } = setup();
    const handler = buildEventHandler(modules);

    const event = makeApprovalEvent({
      approvalId: "non-existent-id",
      action: "approve",
      respondedBy: "user:test",
    });
    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("returns error for already-resolved approval request", async () => {
    const { modules, approvalManager } = setup();
    const handler = buildEventHandler(modules);

    const reqResult = approvalManager.requestApproval({
      action: "shell_exec",
      level: "needs_approval",
      description: "Run test",
      channel: "telegram",
    });
    expect(reqResult.ok).toBe(true);
    if (!reqResult.ok) return;

    // Approve it first
    approvalManager.respond({
      requestId: reqResult.value.id,
      approved: true,
      respondedBy: "user:first",
    });

    // Try to respond again via event handler
    const event = makeApprovalEvent({
      approvalId: reqResult.value.id,
      action: "deny",
      respondedBy: "user:second",
    });
    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(false);
    expect(result.error).toContain("already resolved");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  test("defaults respondedBy to 'unknown' when not provided", async () => {
    const { modules, approvalManager } = setup();
    const handler = buildEventHandler(modules);

    const reqResult = approvalManager.requestApproval({
      action: "shell_exec",
      level: "needs_approval",
      description: "Run build",
      channel: "telegram",
    });
    expect(reqResult.ok).toBe(true);
    if (!reqResult.ok) return;

    const event = makeApprovalEvent({
      approvalId: reqResult.value.id,
      action: "approve",
      // no respondedBy
    });

    const result = await handler(event, DEFAULT_PRIORITY);

    expect(result.success).toBe(true);

    const updated = approvalManager.getById(reqResult.value.id);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value?.respondedBy).toBe("unknown");
  });

  test("works without auditLogger (no crash)", async () => {
    const { modules, approvalManager } = setup();
    // Remove audit logger
    modules.auditLogger = undefined;
    const handler = buildEventHandler(modules);

    const reqResult = approvalManager.requestApproval({
      action: "shell_exec",
      level: "needs_approval",
      description: "Run test",
      channel: "telegram",
    });
    expect(reqResult.ok).toBe(true);
    if (!reqResult.ok) return;

    const event = makeApprovalEvent({
      approvalId: reqResult.value.id,
      action: "deny",
      respondedBy: "user:test",
    });

    // Should not throw even without audit logger
    const result = await handler(event, DEFAULT_PRIORITY);
    expect(result.success).toBe(true);
  });
});
