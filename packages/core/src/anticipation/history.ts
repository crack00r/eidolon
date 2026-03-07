/**
 * SuggestionHistory -- persistence layer for anticipation suggestions.
 * Stores fired suggestions, user feedback, and auto-suppression rules
 * in the operational database.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AnticipationFeedback, PatternType } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuggestionRecord {
  readonly id: string;
  readonly patternType: PatternType;
  readonly detectorId: string;
  readonly entityKey: string | null;
  readonly confidence: number;
  readonly suggestionTitle: string;
  readonly channelId: string;
  readonly firedAt: number;
  readonly dismissedAt: number | null;
  readonly actedOnAt: number | null;
  readonly feedback: AnticipationFeedback | null;
}

export interface SuppressionRecord {
  readonly id: string;
  readonly patternType: PatternType;
  readonly entityKey: string | null;
  readonly suppressedAt: number;
  readonly expiresAt: number | null;
  readonly reason: string;
}

interface HistoryRow {
  id: string;
  pattern_type: string;
  detector_id: string;
  entity_key: string | null;
  confidence: number;
  suggestion_title: string;
  channel_id: string;
  fired_at: number;
  dismissed_at: number | null;
  acted_on_at: number | null;
  feedback: string | null;
}

interface SuppressionRow {
  id: string;
  pattern_type: string;
  entity_key: string | null;
  suppressed_at: number;
  expires_at: number | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// SQL for table creation
// ---------------------------------------------------------------------------

export const ANTICIPATION_HISTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS anticipation_history (
    id TEXT PRIMARY KEY,
    pattern_type TEXT NOT NULL,
    detector_id TEXT NOT NULL,
    entity_key TEXT,
    confidence REAL NOT NULL,
    suggestion_title TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    dismissed_at INTEGER,
    acted_on_at INTEGER,
    feedback TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_anticipation_pattern_type ON anticipation_history(pattern_type);
  CREATE INDEX IF NOT EXISTS idx_anticipation_entity_key ON anticipation_history(entity_key);
  CREATE INDEX IF NOT EXISTS idx_anticipation_fired_at ON anticipation_history(fired_at);

  CREATE TABLE IF NOT EXISTS anticipation_suppressions (
    id TEXT PRIMARY KEY,
    pattern_type TEXT NOT NULL,
    entity_key TEXT,
    suppressed_at INTEGER NOT NULL,
    expires_at INTEGER,
    reason TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_suppression_pattern ON anticipation_suppressions(pattern_type);
`;

// Auto-suppression threshold: 3+ "annoying" feedbacks within 30 days
const AUTO_SUPPRESS_THRESHOLD = 3;
const AUTO_SUPPRESS_WINDOW_DAYS = 30;
const AUTO_SUPPRESS_EXPIRY_DAYS = 30;

// ---------------------------------------------------------------------------
// SuggestionHistory
// ---------------------------------------------------------------------------

export class SuggestionHistory {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.run(ANTICIPATION_HISTORY_SCHEMA);
  }

  /** Record a fired suggestion. */
  record(input: {
    readonly patternType: PatternType;
    readonly detectorId: string;
    readonly entityKey: string | null;
    readonly confidence: number;
    readonly suggestionTitle: string;
    readonly channelId: string;
  }): SuggestionRecord {
    const id = randomUUID();
    const firedAt = Date.now();

    this.db
      .query(
        `INSERT INTO anticipation_history (id, pattern_type, detector_id, entity_key, confidence, suggestion_title, channel_id, fired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.patternType,
        input.detectorId,
        input.entityKey,
        input.confidence,
        input.suggestionTitle,
        input.channelId,
        firedAt,
      );

    return {
      id,
      patternType: input.patternType,
      detectorId: input.detectorId,
      entityKey: input.entityKey,
      confidence: input.confidence,
      suggestionTitle: input.suggestionTitle,
      channelId: input.channelId,
      firedAt,
      dismissedAt: null,
      actedOnAt: null,
      feedback: null,
    };
  }

  /** Get recent suggestions within a time window. */
  getRecent(sinceMs: number): SuggestionRecord[] {
    const rows = this.db
      .query("SELECT * FROM anticipation_history WHERE fired_at >= ? ORDER BY fired_at DESC")
      .all(sinceMs) as HistoryRow[];
    return rows.map(rowToRecord);
  }

  /** Check if a pattern+entity is on cooldown. */
  checkCooldown(patternType: PatternType, entityKey: string | null, cooldownMinutes: number): boolean {
    const cutoff = Date.now() - cooldownMinutes * 60_000;
    const row = this.db
      .query(
        `SELECT COUNT(*) as cnt FROM anticipation_history
         WHERE pattern_type = ? AND (entity_key = ? OR (entity_key IS NULL AND ? IS NULL))
         AND fired_at >= ?`,
      )
      .get(patternType, entityKey, entityKey, cutoff) as { cnt: number } | null;
    return (row?.cnt ?? 0) > 0;
  }

  /** Count suggestions fired in the last hour. */
  countLastHour(): number {
    const cutoff = Date.now() - 3_600_000;
    const row = this.db.query("SELECT COUNT(*) as cnt FROM anticipation_history WHERE fired_at >= ?").get(cutoff) as {
      cnt: number;
    } | null;
    return row?.cnt ?? 0;
  }

  /** Record user feedback on a suggestion. Also triggers auto-suppression check. */
  recordFeedback(suggestionId: string, feedback: AnticipationFeedback): void {
    this.db.query("UPDATE anticipation_history SET feedback = ? WHERE id = ?").run(feedback, suggestionId);

    if (feedback === "annoying") {
      this.checkAutoSuppression(suggestionId);
    }
  }

  /** Record that user acted on a suggestion. */
  recordActed(suggestionId: string): void {
    this.db.query("UPDATE anticipation_history SET acted_on_at = ? WHERE id = ?").run(Date.now(), suggestionId);
  }

  /** Get active suppressions (not expired). */
  getSuppressions(now: number): SuppressionRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM anticipation_suppressions
         WHERE expires_at IS NULL OR expires_at > ?`,
      )
      .all(now) as SuppressionRow[];
    return rows.map(rowToSuppression);
  }

  /** Check if a pattern type is suppressed. */
  isSuppressed(patternType: PatternType, now: number): boolean {
    const row = this.db
      .query(
        `SELECT COUNT(*) as cnt FROM anticipation_suppressions
         WHERE pattern_type = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(patternType, now) as { cnt: number } | null;
    return (row?.cnt ?? 0) > 0;
  }

  /** Auto-suppress a pattern type if it received too many "annoying" feedbacks. */
  private checkAutoSuppression(suggestionId: string): void {
    const record = this.db.query("SELECT pattern_type FROM anticipation_history WHERE id = ?").get(suggestionId) as {
      pattern_type: string;
    } | null;
    if (!record) return;

    const cutoff = Date.now() - AUTO_SUPPRESS_WINDOW_DAYS * 86_400_000;
    const countRow = this.db
      .query(
        `SELECT COUNT(*) as cnt FROM anticipation_history
         WHERE pattern_type = ? AND feedback = 'annoying' AND fired_at >= ?`,
      )
      .get(record.pattern_type, cutoff) as { cnt: number } | null;

    if ((countRow?.cnt ?? 0) >= AUTO_SUPPRESS_THRESHOLD) {
      const id = randomUUID();
      const expiresAt = Date.now() + AUTO_SUPPRESS_EXPIRY_DAYS * 86_400_000;
      this.db
        .query(
          `INSERT OR IGNORE INTO anticipation_suppressions (id, pattern_type, entity_key, suppressed_at, expires_at, reason)
           VALUES (?, ?, NULL, ?, ?, 'user_dismissed_3x')`,
        )
        .run(id, record.pattern_type, Date.now(), expiresAt);
      this.logger.info("anticipation", `Auto-suppressed pattern: ${record.pattern_type} (3+ annoying feedbacks)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToRecord(row: HistoryRow): SuggestionRecord {
  return {
    id: row.id,
    patternType: row.pattern_type as PatternType,
    detectorId: row.detector_id,
    entityKey: row.entity_key,
    confidence: row.confidence,
    suggestionTitle: row.suggestion_title,
    channelId: row.channel_id,
    firedAt: row.fired_at,
    dismissedAt: row.dismissed_at,
    actedOnAt: row.acted_on_at,
    feedback: row.feedback as AnticipationFeedback | null,
  };
}

function rowToSuppression(row: SuppressionRow): SuppressionRecord {
  return {
    id: row.id,
    patternType: row.pattern_type as PatternType,
    entityKey: row.entity_key,
    suppressedAt: row.suppressed_at,
    expiresAt: row.expires_at,
    reason: row.reason,
  };
}
