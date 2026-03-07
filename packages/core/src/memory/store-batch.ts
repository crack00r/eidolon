/**
 * Batch and similarity operations for MemoryStore.
 * Extracted from store.ts to keep files under 300 lines.
 *
 * These functions are called by MemoryStore and re-exported from store.ts
 * for backward compatibility.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Memory, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { CreateMemoryInput, MemoryRow } from "./store-helpers.ts";
import { cosineSimilarity, MAX_BATCH_SIZE, MAX_CONTENT_LENGTH, rowToMemory } from "./store-helpers.ts";

// ---------------------------------------------------------------------------
// findSimilar
// ---------------------------------------------------------------------------

/**
 * Find memories whose embeddings are similar to a given embedding.
 * Returns memories sorted by descending cosine similarity, along with the
 * similarity score. Only memories with embeddings stored are considered.
 */
export function findSimilarMemories(
  db: Database,
  embedding: Float32Array,
  limit: number,
  minSimilarity?: number,
): Result<Array<{ memory: Memory; similarity: number }>, EidolonError> {
  try {
    const MIN_SIMILARITY = minSimilarity ?? 0;
    const EXPECTED_DIMENSIONS = 384;

    const rows = db.query("SELECT * FROM memories WHERE embedding IS NOT NULL LIMIT 10000").all() as Array<
      MemoryRow & { embedding: Uint8Array }
    >;

    const scored: Array<{ memory: Memory; similarity: number }> = [];

    for (const row of rows) {
      const storedEmbedding = new Float32Array(new Uint8Array(row.embedding).buffer);
      if (storedEmbedding.length !== EXPECTED_DIMENSIONS) continue;
      if (embedding.length !== EXPECTED_DIMENSIONS) continue;

      const similarity = cosineSimilarity(embedding, storedEmbedding);
      if (similarity >= MIN_SIMILARITY) {
        scored.push({ memory: rowToMemory(row), similarity });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return Ok(scored.slice(0, limit));
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to find similar memories", cause));
  }
}

// ---------------------------------------------------------------------------
// createBatch
// ---------------------------------------------------------------------------

/** Bulk create memories within a single transaction. */
export function createMemoryBatch(
  db: Database,
  logger: Logger,
  inputs: readonly CreateMemoryInput[],
): Result<Memory[], EidolonError> {
  if (inputs.length > MAX_BATCH_SIZE) {
    return Err(
      createError(ErrorCode.DB_QUERY_FAILED, `Batch size exceeds maximum (${inputs.length} > ${MAX_BATCH_SIZE})`),
    );
  }
  for (const input of inputs) {
    if (input.content.length > MAX_CONTENT_LENGTH) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Memory content exceeds maximum length (${input.content.length} > ${MAX_CONTENT_LENGTH})`,
        ),
      );
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Memory confidence must be a finite number in [0, 1], got ${input.confidence}`,
        ),
      );
    }
  }
  try {
    const memories: Memory[] = [];

    const insertFn = db.transaction(() => {
      for (const input of inputs) {
        const id = randomUUID();
        const now = Date.now();
        const tags = JSON.stringify(input.tags ?? []);
        const metadata = JSON.stringify(input.metadata ?? {});
        const sensitive = input.sensitive ? 1 : 0;

        db.query(
          `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata, sensitive)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        ).run(
          id,
          input.type,
          input.layer,
          input.content,
          input.confidence,
          input.source,
          tags,
          now,
          now,
          now,
          metadata,
          sensitive,
        );

        memories.push({
          id,
          type: input.type,
          layer: input.layer,
          content: input.content,
          confidence: input.confidence,
          source: input.source,
          tags: input.tags ? [...input.tags] : [],
          createdAt: now,
          updatedAt: now,
          accessedAt: now,
          accessCount: 0,
          metadata: input.metadata ?? {},
          sensitive: input.sensitive ?? false,
        });
      }
    });

    insertFn();

    logger.debug("createBatch", `Created ${memories.length} memories in batch`);
    return Ok(memories);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create memory batch", cause));
  }
}
