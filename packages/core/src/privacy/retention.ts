/**
 * RetentionEnforcer -- automated data retention enforcement.
 *
 * Runs periodically (e.g., daily via scheduler) and deletes data older
 * than configured retention periods. Audit logs are NEVER deleted
 * (legal requirement) unless explicitly configured otherwise.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, PrivacyConfig, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

export interface RetentionReport {
  readonly timestamp: number;
  readonly deletedCounts: Record<string, number>;
  readonly totalDeleted: number;
  readonly errors: readonly string[];
}

export interface RetentionConfig {
  readonly conversationsDays: number;
  readonly eventsDays: number;
  readonly tokenUsageDays: number;
  readonly auditLogDays: number; // -1 = never delete
}

// ---------------------------------------------------------------------------
// Default retention periods
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION: RetentionConfig = {
  conversationsDays: 365,
  eventsDays: 90,
  tokenUsageDays: 180,
  auditLogDays: -1, // NEVER delete (legal requirement)
};

// ---------------------------------------------------------------------------
// RetentionEnforcer
// ---------------------------------------------------------------------------

export class RetentionEnforcer {
  private readonly operational: Database;
  private readonly audit: Database;
  private readonly config: RetentionConfig;
  private readonly logger: Logger;

  constructor(operational: Database, audit: Database, privacyConfig: PrivacyConfig | undefined, logger: Logger) {
    this.operational = operational;
    this.audit = audit;
    this.config = privacyConfig?.retention
      ? {
          conversationsDays: privacyConfig.retention.conversationsDays,
          eventsDays: privacyConfig.retention.eventsDays,
          tokenUsageDays: privacyConfig.retention.tokenUsageDays,
          auditLogDays: privacyConfig.retention.auditLogDays,
        }
      : DEFAULT_RETENTION;
    this.logger = logger.child("retention");
  }

  /**
   * Enforce retention policies across all applicable tables.
   * Returns a report of what was deleted.
   */
  enforce(): Result<RetentionReport, EidolonError> {
    const deletedCounts: Record<string, number> = {};
    const errors: string[] = [];
    const now = Date.now();

    this.logger.info("enforce", "Starting retention enforcement", {
      config: this.config,
    });

    // --- operational.db: sessions (conversations) ---
    // Delete token_usage records for sessions about to be deleted, then delete the sessions.
    try {
      const cutoff = now - this.config.conversationsDays * MS_PER_DAY;
      const tokenResult = this.operational
        .query(
          "DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE started_at < ? AND status IN ('completed', 'failed'))",
        )
        .run(cutoff);
      deletedCounts.session_token_usage = tokenResult.changes;
      const result = this.operational
        .query("DELETE FROM sessions WHERE started_at < ? AND status IN ('completed', 'failed')")
        .run(cutoff);
      deletedCounts.sessions = result.changes;
    } catch (cause) {
      const msg = `Failed to enforce retention on sessions: ${String(cause)}`;
      errors.push(msg);
      this.logger.warn("enforce", msg);
      deletedCounts.sessions = 0;
      deletedCounts.session_token_usage = 0;
    }

    // --- operational.db: events ---
    try {
      const cutoff = now - this.config.eventsDays * MS_PER_DAY;
      const result = this.operational
        .query("DELETE FROM events WHERE timestamp < ? AND processed_at IS NOT NULL")
        .run(cutoff);
      deletedCounts.events = result.changes;
    } catch (cause) {
      const msg = `Failed to enforce retention on events: ${String(cause)}`;
      errors.push(msg);
      this.logger.warn("enforce", msg);
      deletedCounts.events = 0;
    }

    // --- operational.db: token_usage ---
    try {
      const cutoff = now - this.config.tokenUsageDays * MS_PER_DAY;
      const result = this.operational.query("DELETE FROM token_usage WHERE timestamp < ?").run(cutoff);
      deletedCounts.token_usage = result.changes;
    } catch (cause) {
      const msg = `Failed to enforce retention on token_usage: ${String(cause)}`;
      errors.push(msg);
      this.logger.warn("enforce", msg);
      deletedCounts.token_usage = 0;
    }

    // --- operational.db: discoveries ---
    try {
      const cutoff = now - this.config.conversationsDays * MS_PER_DAY;
      const result = this.operational
        .query("DELETE FROM discoveries WHERE created_at < ? AND status IN ('rejected', 'implemented')")
        .run(cutoff);
      deletedCounts.discoveries = result.changes;
    } catch (cause) {
      const msg = `Failed to enforce retention on discoveries: ${String(cause)}`;
      errors.push(msg);
      this.logger.warn("enforce", msg);
      deletedCounts.discoveries = 0;
    }

    // --- audit.db: audit_log ---
    // audit_log entries are protected by the audit_no_delete trigger (tamper-proof compliance).
    // DELETE operations on audit_log will be ABORTed by the trigger, so we skip deletion entirely.
    deletedCounts.audit_log = 0;
    if (this.config.auditLogDays > 0) {
      this.logger.warn(
        "enforce",
        `auditLogDays is set to ${this.config.auditLogDays} but audit log retention is not enforced ` +
          "due to tamper-proof audit_no_delete trigger. Audit log entries cannot be deleted.",
      );
    } else {
      this.logger.debug("enforce", "Audit log retention: NEVER delete (legal requirement)");
    }

    const totalDeleted = Object.values(deletedCounts).reduce((sum, n) => sum + n, 0);

    const report: RetentionReport = {
      timestamp: now,
      deletedCounts,
      totalDeleted,
      errors,
    };

    if (errors.length > 0) {
      this.logger.warn("enforce", `Retention enforcement completed with ${errors.length} error(s)`, {
        totalDeleted,
        errorCount: errors.length,
      });
      return Err(
        createError(
          ErrorCode.RETENTION_ENFORCEMENT_FAILED,
          `Retention enforcement completed with ${errors.length} error(s). Deleted ${totalDeleted} total records.`,
        ),
      );
    }

    this.logger.info("enforce", `Retention enforcement completed: ${totalDeleted} records deleted`, {
      deletedCounts,
    });

    return Ok(report);
  }
}
