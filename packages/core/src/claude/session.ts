/**
 * Session lifecycle management for Claude Code subprocesses.
 *
 * Tracks active and historical sessions in the operational database.
 * Each session maps to one Claude Code subprocess.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Result, SessionInfo, SessionType } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

/**
 * Manages session lifecycle in the operational database.
 */
export class SessionManager {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("sessions");
  }

  /** Create a new session */
  create(type: SessionType, claudeSessionId?: string): Result<SessionInfo, EidolonError> {
    const id = randomUUID();
    const now = Date.now();

    try {
      this.db
        .query(
          `INSERT INTO sessions (id, type, status, claude_session_id, started_at, last_activity_at)
         VALUES (?, ?, 'running', ?, ?, ?)`,
        )
        .run(id, type, claudeSessionId ?? null, now, now);

      const session: SessionInfo = {
        id,
        type,
        startedAt: now,
        lastActivityAt: now,
        tokensUsed: 0,
        status: "running",
        claudeSessionId,
      };

      this.logger.info("sessions", `Created session ${id}`, { type });
      return Ok(session);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create session", cause));
    }
  }

  /** Update session status */
  updateStatus(sessionId: string, status: SessionInfo["status"]): Result<void, EidolonError> {
    try {
      const now = Date.now();
      this.db
        .query(
          `UPDATE sessions SET status = ?, last_activity_at = ?,
         completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
         WHERE id = ?`,
        )
        .run(status, now, status, now, sessionId);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to update session", cause));
    }
  }

  /** Record token usage for a session */
  addTokens(sessionId: string, tokens: number, costUsd: number): Result<void, EidolonError> {
    try {
      this.db
        .query(
          `UPDATE sessions SET tokens_used = tokens_used + ?, cost_usd = cost_usd + ?,
         last_activity_at = ? WHERE id = ?`,
        )
        .run(tokens, costUsd, Date.now(), sessionId);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to update tokens", cause));
    }
  }

  /** Get a session by ID */
  get(sessionId: string): Result<SessionInfo | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId);
      if (!row) return Ok(null);
      return Ok(this.rowToSession(row));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get session", cause));
    }
  }

  /** List sessions by status */
  listByStatus(status: SessionInfo["status"]): Result<SessionInfo[], EidolonError> {
    try {
      const rows = this.db.query("SELECT * FROM sessions WHERE status = ? ORDER BY started_at DESC").all(status);
      return Ok((rows as Array<Record<string, unknown>>).map((r) => this.rowToSession(r)));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list sessions", cause));
    }
  }

  /** List all active (running) sessions */
  listActive(): Result<SessionInfo[], EidolonError> {
    return this.listByStatus("running");
  }

  /** Count active sessions by type */
  countByType(type: SessionType): number {
    const row = this.db.query("SELECT COUNT(*) as count FROM sessions WHERE type = ? AND status = 'running'").get(type);
    // Runtime validation instead of unsafe `as` cast
    if (!row || typeof row !== "object" || !("count" in row)) {
      return 0;
    }
    return Number((row as Record<string, unknown>).count);
  }

  private static readonly VALID_SESSION_TYPES = new Set<string>([
    "main",
    "task",
    "learning",
    "dream",
    "voice",
    "review",
  ]);
  private static readonly VALID_SESSION_STATUSES = new Set<string>(["running", "paused", "completed", "failed"]);

  private static validateEnum<T extends string>(value: unknown, valid: Set<string>, fallback: T): T {
    return valid.has(String(value)) ? (String(value) as T) : fallback;
  }

  private rowToSession(row: unknown): SessionInfo {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      type: SessionManager.validateEnum<SessionType>(r.type, SessionManager.VALID_SESSION_TYPES, "task"),
      startedAt: Number(r.started_at),
      lastActivityAt: Number(r.last_activity_at),
      tokensUsed: Number(r.tokens_used),
      status: SessionManager.validateEnum<SessionInfo["status"]>(
        r.status,
        SessionManager.VALID_SESSION_STATUSES,
        "failed",
      ),
      claudeSessionId: r.claude_session_id ? String(r.claude_session_id) : undefined,
    };
  }
}
