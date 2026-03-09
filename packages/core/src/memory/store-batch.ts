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
import {
  cosineSimilarity,
  MAX_BATCH_SIZE,
  MAX_CONTENT_LENGTH,
  rowToMemory,
  VALID_MEMORY_LAYERS,
  VALID_MEMORY_TYPES,
} from "./store-helpers.ts";

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
  logger?: Logger,
): Result<Array<{ memory: Memory; similarity: number }>, EidolonError> {
  try {
    const MIN_SIMILARITY = minSimilarity ?? 0;
    const EXPECTED_DIMENSIONS = 384;

    // Phase 1: scan embeddings only (id + embedding) in batches to find top candidates
    const BATCH_SIZE = 2000;
    const MAX_ROWS = 10000;
    const topK: Array<{ memoryId: string; similarity: number }> = [];
    let minTopKSimilarity = -Infinity;

    for (let offset = 0; offset < MAX_ROWS; offset += BATCH_SIZE) {
      const batchRows = db
        .query("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY rowid LIMIT ? OFFSET ?")
        .all(BATCH_SIZE, offset) as Array<{ id: string; embedding: Uint8Array }>;

      if (batchRows.length === 0) break;

      for (const row of batchRows) {
        const storedEmbedding = new Float32Array(
          row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
        );
        if (storedEmbedding.length !== EXPECTED_DIMENSIONS) continue;
        if (embedding.length !== EXPECTED_DIMENSIONS) continue;

        const similarity = cosineSimilarity(embedding, storedEmbedding);
        if (similarity < MIN_SIMILARITY) continue;

        if (topK.length < limit) {
          topK.push({ memoryId: row.id, similarity });
          if (topK.length === limit) {
            topK.sort((a, b) => b.similarity - a.similarity);
            const last = topK[topK.length - 1];
            minTopKSimilarity = last ? last.similarity : -Infinity;
          }
        } else if (similarity > minTopKSimilarity) {
          topK[topK.length - 1] = { memoryId: row.id, similarity };
          topK.sort((a, b) => b.similarity - a.similarity);
          const last = topK[topK.length - 1];
          minTopKSimilarity = last ? last.similarity : -Infinity;
        }
      }

      if (batchRows.length < BATCH_SIZE) break;
    }

    // Warn if the scan was truncated at MAX_ROWS -- consolidation may miss duplicates
    if (topK.length > 0) {
      // Check if we hit the MAX_ROWS ceiling by seeing if the last batch was full
      const lastBatchOffset = Math.floor((MAX_ROWS - BATCH_SIZE) / BATCH_SIZE) * BATCH_SIZE;
      if (lastBatchOffset + BATCH_SIZE <= MAX_ROWS) {
        const checkRows = db.query("SELECT COUNT(*) as cnt FROM memories WHERE embedding IS NOT NULL").get() as {
          cnt: number;
        } | null;
        if (checkRows && checkRows.cnt >= MAX_ROWS) {
          const msg = `findSimilarMemories: result set truncated at ${MAX_ROWS} rows (total: ${checkRows.cnt}), consolidation may miss duplicates`;
          if (logger) {
            logger.warn("store-batch", msg);
          }
          // No fallback to console.warn -- callers should always provide a logger
        }
      }
    }

    topK.sort((a, b) => b.similarity - a.similarity);

    // Phase 2: fetch full rows only for top candidates
    const scored: Array<{ memory: Memory; similarity: number }> = [];
    for (const candidate of topK) {
      const fullRow = db.query("SELECT * FROM memories WHERE id = ?").get(candidate.memoryId) as MemoryRow | null;
      if (fullRow) {
        scored.push({ memory: rowToMemory(fullRow), similarity: candidate.similarity });
      }
    }

    return Ok(scored);
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
    if (!VALID_MEMORY_TYPES.has(input.type)) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Invalid memory type: "${input.type}"`));
    }
    if (!VALID_MEMORY_LAYERS.has(input.layer)) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Invalid memory layer: "${input.layer}"`));
    }
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
        const userId = input.userId ?? "default";

        db.query(
          `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata, sensitive, user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
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
          userId,
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
