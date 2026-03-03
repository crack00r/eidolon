/**
 * FeedbackStore -- CRUD for response ratings stored in operational.db.
 *
 * Users rate Eidolon's responses (1-5 stars). Ratings are persisted and
 * used to:
 *   1. Adjust memory extraction confidence for the associated session.
 *   2. Provide a training signal during the dreaming consolidation phase.
 *   3. Surface quality trends in dashboards and CLI reports.
 *
 * All methods return Result<T, EidolonError> for consistent error handling.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, FeedbackEntry, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmitFeedbackInput {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly rating: number;
  readonly channel: string;
  readonly comment?: string;
}

export interface FeedbackListOptions {
  readonly sessionId?: string;
  readonly limit?: number;
  readonly since?: number;
}

export interface FeedbackSummary {
  readonly count: number;
  readonly averageRating: number;
  readonly positiveCount: number;
  readonly negativeCount: number;
}

// ---------------------------------------------------------------------------
// Internal row shape from SQLite
// ---------------------------------------------------------------------------

interface FeedbackRow {
  readonly id: string;
  readonly session_id: string;
  readonly message_id: string | null;
  readonly rating: number;
  readonly channel: string;
  readonly comment: string | null;
  readonly created_at: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ratings >= this threshold are considered positive. */
const POSITIVE_THRESHOLD = 4;

/** Ratings <= this threshold are considered negative. */
const NEGATIVE_THRESHOLD = 2;

/** Maximum number of feedback entries returned in a single list query. */
const MAX_LIST_LIMIT = 500;

/** Default number of feedback entries returned when no limit is specified. */
const DEFAULT_LIST_LIMIT = 50;

/** Maximum comment length to prevent abuse. */
const MAX_COMMENT_LENGTH = 2000;

/**
 * Confidence adjustment applied to memories from a session when feedback is received.
 * Positive feedback (>= 4) adds this value; negative feedback (<= 2) subtracts it.
 */
export const CONFIDENCE_ADJUSTMENT = 0.05;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToEntry(row: FeedbackRow): FeedbackEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id ?? undefined,
    rating: row.rating,
    channel: row.channel,
    comment: row.comment ?? undefined,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// FeedbackStore
// ---------------------------------------------------------------------------

export class FeedbackStore {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("feedback-store");
  }

  /**
   * Submit a feedback rating for a response.
   * Returns the created FeedbackEntry on success.
   */
  submit(input: SubmitFeedbackInput): Result<FeedbackEntry, EidolonError> {
    // Validate rating
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      return Err(
        createError(ErrorCode.DB_QUERY_FAILED, `Rating must be an integer between 1 and 5, got ${input.rating}`),
      );
    }

    // Validate sessionId is non-empty
    if (!input.sessionId || input.sessionId.trim().length === 0) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "sessionId must be a non-empty string"));
    }

    // Validate channel is non-empty
    if (!input.channel || input.channel.trim().length === 0) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "channel must be a non-empty string"));
    }

    const id = randomUUID();
    const now = Date.now();
    const comment = input.comment !== undefined ? input.comment.slice(0, MAX_COMMENT_LENGTH) : null;

    try {
      this.db
        .query(
          `INSERT INTO feedback (id, session_id, message_id, rating, channel, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.sessionId, input.messageId ?? null, input.rating, input.channel, comment, now);

      const entry: FeedbackEntry = {
        id,
        sessionId: input.sessionId,
        messageId: input.messageId,
        rating: input.rating,
        channel: input.channel,
        comment: comment ?? undefined,
        createdAt: now,
      };

      this.logger.debug("submit", "Feedback recorded", {
        id,
        sessionId: input.sessionId,
        rating: input.rating,
        channel: input.channel,
      });

      return Ok(entry);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to submit feedback: ${message}`, err));
    }
  }

  /**
   * List feedback entries, optionally filtered by sessionId and/or time range.
   */
  list(options?: FeedbackListOptions): Result<FeedbackEntry[], EidolonError> {
    try {
      const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (options?.sessionId) {
        conditions.push("session_id = ?");
        params.push(options.sessionId);
      }

      if (options?.since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(options.since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `SELECT * FROM feedback ${where} ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);

      const rows = this.db.query(sql).all(...params) as FeedbackRow[];
      return Ok(rows.map(rowToEntry));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to list feedback: ${message}`, err));
    }
  }

  /**
   * Get a single feedback entry by id.
   */
  get(id: string): Result<FeedbackEntry | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM feedback WHERE id = ?").get(id) as FeedbackRow | null;
      return Ok(row ? rowToEntry(row) : null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get feedback: ${message}`, err));
    }
  }

  /**
   * Get an aggregate summary of feedback, optionally scoped to a session or time range.
   */
  getSummary(options?: FeedbackListOptions): Result<FeedbackSummary, EidolonError> {
    try {
      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (options?.sessionId) {
        conditions.push("session_id = ?");
        params.push(options.sessionId);
      }

      if (options?.since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(options.since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const row = this.db
        .query(
          `SELECT
             COUNT(*) as count,
             COALESCE(AVG(rating), 0) as avg_rating,
             COALESCE(SUM(CASE WHEN rating >= ${POSITIVE_THRESHOLD} THEN 1 ELSE 0 END), 0) as positive_count,
             COALESCE(SUM(CASE WHEN rating <= ${NEGATIVE_THRESHOLD} THEN 1 ELSE 0 END), 0) as negative_count
           FROM feedback ${where}`,
        )
        .get(...params) as Record<string, unknown> | null;

      const count = typeof row?.count === "number" ? row.count : 0;
      const averageRating = typeof row?.avg_rating === "number" ? row.avg_rating : 0;
      const positiveCount = typeof row?.positive_count === "number" ? row.positive_count : 0;
      const negativeCount = typeof row?.negative_count === "number" ? row.negative_count : 0;

      return Ok({ count, averageRating, positiveCount, negativeCount });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get feedback summary: ${message}`, err));
    }
  }

  /**
   * Calculate the confidence adjustment for a given rating.
   * Positive ratings (>= 4) return a positive adjustment.
   * Negative ratings (<= 2) return a negative adjustment.
   * Neutral ratings (3) return 0.
   */
  static confidenceAdjustment(rating: number): number {
    if (rating >= POSITIVE_THRESHOLD) return CONFIDENCE_ADJUSTMENT;
    if (rating <= NEGATIVE_THRESHOLD) return -CONFIDENCE_ADJUSTMENT;
    return 0;
  }
}
