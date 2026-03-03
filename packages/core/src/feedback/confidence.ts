/**
 * Confidence adjustment -- updates memory confidence scores based on user feedback.
 *
 * When a user rates a response, memories extracted from the associated session
 * have their confidence adjusted:
 *   - Positive feedback (rating >= 4): +CONFIDENCE_ADJUSTMENT
 *   - Negative feedback (rating <= 2): -CONFIDENCE_ADJUSTMENT
 *   - Neutral feedback (rating == 3): no change
 *
 * Memories are linked to sessions via the `metadata.sessionId` JSON field
 * stored in the memories table.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logging/logger.ts";
import { FeedbackStore, CONFIDENCE_ADJUSTMENT } from "./store.ts";

// ---------------------------------------------------------------------------
// Internal row shape for memory queries
// ---------------------------------------------------------------------------

interface MemoryIdRow {
  readonly id: string;
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Adjust memory confidence for all memories linked to a given session.
 *
 * @param memoryDb   The memory.db database handle (not operational.db)
 * @param sessionId  The session whose memories should be adjusted
 * @param rating     The user's rating (1-5)
 * @param logger     Logger instance for tracing
 * @returns The number of memories whose confidence was updated
 */
export function adjustSessionMemoryConfidence(
  memoryDb: Database,
  sessionId: string,
  rating: number,
  logger: Logger,
): number {
  const adjustment = FeedbackStore.confidenceAdjustment(rating);
  if (adjustment === 0) {
    logger.debug("confidence", "Neutral rating, no confidence adjustment", { sessionId, rating });
    return 0;
  }

  const log = logger.child("confidence");

  // Find memories whose metadata JSON contains the target sessionId.
  // The metadata column stores JSON like: {"sessionId":"sess-123"}
  const rows = memoryDb
    .query(
      `SELECT id, confidence FROM memories
       WHERE json_extract(metadata, '$.sessionId') = ?`,
    )
    .all(sessionId) as MemoryIdRow[];

  if (rows.length === 0) {
    log.debug("adjust", "No memories found for session", { sessionId });
    return 0;
  }

  const updateStmt = memoryDb.prepare(
    `UPDATE memories SET confidence = MAX(0, MIN(1, confidence + ?)), updated_at = ?
     WHERE id = ?`,
  );

  const now = Date.now();
  let updated = 0;

  for (const row of rows) {
    const newConfidence = Math.max(0, Math.min(1, row.confidence + adjustment));
    // Skip if the value would not actually change (already at boundary)
    if (newConfidence === row.confidence) continue;

    updateStmt.run(adjustment, now, row.id);
    updated++;
  }

  log.info("adjust", `Adjusted confidence for ${updated} memories`, {
    sessionId,
    rating,
    adjustment,
    totalFound: rows.length,
    updated,
  });

  return updated;
}

/**
 * Subscribe to user:feedback events on the EventBus and automatically
 * adjust memory confidence. Returns an unsubscribe function.
 *
 * @param eventBus   The EventBus to subscribe to
 * @param memoryDb   The memory.db database handle
 * @param logger     Logger instance
 */
export function subscribeFeedbackConfidenceAdjustment(
  eventBus: { subscribe: (type: string, handler: (event: { payload: Record<string, unknown> }) => void) => () => void },
  memoryDb: Database,
  logger: Logger,
): () => void {
  const log = logger.child("feedback-confidence");

  return eventBus.subscribe("user:feedback", (event) => {
    const payload = event.payload;
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    const rating = typeof payload.rating === "number" ? payload.rating : undefined;

    if (!sessionId || rating === undefined) {
      log.warn("subscribe", "Invalid user:feedback payload, skipping confidence adjustment", {
        payload: String(payload),
      });
      return;
    }

    try {
      adjustSessionMemoryConfidence(memoryDb, sessionId, rating, logger);
    } catch (err) {
      log.error("subscribe", "Failed to adjust memory confidence on feedback", err, {
        sessionId,
        rating,
      });
    }
  });
}
