/**
 * Vector search helpers for MemorySearch.
 *
 * Contains sqlite-vec ANN initialization, brute-force cosine similarity
 * fallback, and embedding storage/retrieval operations.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { EmbeddingModel } from "./embeddings.ts";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface EmbeddingRow {
  readonly id: string;
  readonly embedding: Uint8Array;
}

/** Row returned from sqlite-vec KNN query. */
export interface Vec0KnnRow {
  readonly rowid: number;
  readonly distance: number;
}

/** Mapping row for rowid -> memory id lookup. */
export interface RowIdMapping {
  readonly rowid: number;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Batch size for vector similarity scan (brute-force fallback). Rows are
 * processed in chunks of this size rather than loading all into memory at
 * once. At 384 dims x 4 bytes x 2000 rows = ~3 MB per batch, a manageable
 * working set.
 */
const VECTOR_SCAN_BATCH_SIZE = 2000;
/**
 * Maximum total rows scanned during brute-force vector similarity search.
 * When sqlite-vec is available, this limit does not apply (ANN handles
 * arbitrarily large datasets).
 */
const MAX_VECTOR_SCAN_ROWS = 100_000;
/** Expected embedding dimension (must match EmbeddingModel output). */
const EXPECTED_DIMENSIONS = 384;
/** Name of the sqlite-vec virtual table for memory embeddings. */
export const VEC0_TABLE_NAME = "memory_embeddings";

// ---------------------------------------------------------------------------
// Vec0 initialization
// ---------------------------------------------------------------------------

/**
 * Attempt to create the sqlite-vec vec0 virtual table for ANN search.
 *
 * If the sqlite-vec extension is not loaded, the CREATE VIRTUAL TABLE
 * statement will throw and we silently fall back to brute-force scanning.
 * This makes sqlite-vec an optional performance optimisation rather than
 * a hard dependency.
 *
 * @returns true if vec0 is available for ANN search.
 */
export function initVec0Table(db: Database, logger: Logger): boolean {
  try {
    // Check if table already exists
    const existing = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(VEC0_TABLE_NAME) as { name: string } | null;

    if (existing) {
      // Table exists -- verify we can query it (extension might have been
      // loaded when the table was created but not in this session)
      try {
        db.query(`SELECT rowid FROM ${VEC0_TABLE_NAME} LIMIT 0`).all();
        logger.info("initVec0", "sqlite-vec vec0 table available for ANN search");
        return true;
      } catch {
        // Table exists but cannot be queried (extension not loaded)
        logger.warn(
          "initVec0",
          `${VEC0_TABLE_NAME} table exists but sqlite-vec extension not loaded; falling back to brute-force`,
        );
        return false;
      }
    }

    // Try to create the vec0 table (requires sqlite-vec extension)
    db.run(`CREATE VIRTUAL TABLE ${VEC0_TABLE_NAME} USING vec0(embedding float[${EXPECTED_DIMENSIONS}])`);
    logger.info("initVec0", "Created sqlite-vec vec0 table for ANN search");

    // Backfill existing embeddings from the memories table
    backfillVec0Table(db, logger);
    return true;
  } catch {
    // sqlite-vec extension not available -- use brute-force fallback
    logger.info("initVec0", "sqlite-vec extension not available; using brute-force vector search fallback");
    return false;
  }
}

/**
 * Backfill the vec0 table from existing embeddings in the memories table.
 * Called once when the vec0 table is first created on an existing database.
 */
function backfillVec0Table(db: Database, logger: Logger): void {
  try {
    const rows = db.query("SELECT rowid, embedding FROM memories WHERE embedding IS NOT NULL").all() as Array<{
      rowid: number;
      embedding: Uint8Array;
    }>;

    if (rows.length === 0) return;

    const insertStmt = db.prepare(`INSERT OR REPLACE INTO ${VEC0_TABLE_NAME}(rowid, embedding) VALUES (?, ?)`);
    const transaction = db.transaction(() => {
      for (const row of rows) {
        insertStmt.run(row.rowid, row.embedding);
      }
    });
    transaction();

    logger.info("backfillVec0", `Backfilled ${rows.length} embeddings into vec0 table`);
  } catch (cause) {
    logger.warn("backfillVec0", "Failed to backfill vec0 table", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// ---------------------------------------------------------------------------
// sqlite-vec ANN search
// ---------------------------------------------------------------------------

/**
 * Vector similarity search using sqlite-vec's native KNN via the MATCH
 * operator on the vec0 virtual table.
 *
 * sqlite-vec returns results ordered by L2 distance. We convert distance
 * to a similarity score using `1 / (1 + distance)` which maps distance=0
 * to similarity=1 and larger distances to values approaching 0.
 */
export function searchVectorVec0(
  db: Database,
  queryEmbedding: Float32Array,
  limit: number,
  logger: Logger,
  onFallback: () => void,
): Result<Array<{ memoryId: string; similarity: number }>, EidolonError> {
  try {
    // sqlite-vec expects the query vector as a raw byte buffer
    const queryBlob = new Uint8Array(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);

    // KNN query via sqlite-vec MATCH operator
    // Returns rowid + distance ordered by distance ascending (closest first)
    const rows = db
      .query(`SELECT rowid, distance FROM ${VEC0_TABLE_NAME} WHERE embedding MATCH ? AND k = ?`)
      .all(queryBlob, limit) as Vec0KnnRow[];

    if (rows.length === 0) {
      return Ok([]);
    }

    // Map rowids back to memory IDs via the memories table
    const rowids = rows.map((r) => r.rowid);
    const placeholders = rowids.map(() => "?").join(",");
    const idRows = db
      .query(`SELECT rowid, id FROM memories WHERE rowid IN (${placeholders})`)
      .all(...rowids) as RowIdMapping[];

    const rowidToId = new Map<number, string>();
    for (const row of idRows) {
      rowidToId.set(row.rowid, row.id);
    }

    // Build results with similarity scores
    const results: Array<{ memoryId: string; similarity: number }> = [];
    for (const row of rows) {
      const memoryId = rowidToId.get(row.rowid);
      if (!memoryId) continue;

      // Convert L2 distance to similarity: 1/(1+distance)
      // distance=0 -> similarity=1, larger distance -> lower similarity
      const similarity = 1 / (1 + row.distance);
      results.push({ memoryId, similarity });
    }

    logger.debug("searchVectorVec0", `ANN search returned ${results.length} results`, {
      limit,
      returnedCount: results.length,
    });

    return Ok(results);
  } catch (cause) {
    // If vec0 query fails at runtime (e.g. extension unloaded), fall back
    logger.warn("searchVectorVec0", "sqlite-vec ANN query failed; falling back to brute-force", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    onFallback();
    return searchVectorBruteForce(db, queryEmbedding, limit, logger);
  }
}

// ---------------------------------------------------------------------------
// Brute-force vector search (fallback)
// ---------------------------------------------------------------------------

/**
 * Brute-force vector similarity search via batched cosine similarity
 * scanning. Used as fallback when sqlite-vec is not available.
 */
export function searchVectorBruteForce(
  db: Database,
  queryEmbedding: Float32Array,
  limit: number,
  logger: Logger,
): Result<Array<{ memoryId: string; similarity: number }>, EidolonError> {
  try {
    // Count total rows to scan (for logging and progress tracking)
    const countRow = db.query("SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL").get() as {
      count: number;
    };
    const totalRows = Math.min(countRow.count, MAX_VECTOR_SCAN_ROWS);

    if (totalRows === 0) {
      return Ok([]);
    }

    // Use a bounded candidate list: only keep top `limit` results
    const topK: Array<{ memoryId: string; similarity: number }> = [];
    let minTopKSimilarity = -Infinity;
    let scannedCount = 0;

    // Process in batches using LIMIT/OFFSET for cursor-based pagination.
    // Using rowid ordering ensures stable pagination even under concurrent writes.
    for (let offset = 0; offset < totalRows; offset += VECTOR_SCAN_BATCH_SIZE) {
      const batchLimit = Math.min(VECTOR_SCAN_BATCH_SIZE, totalRows - offset);
      const rows = db
        .query("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY rowid LIMIT ? OFFSET ?")
        .all(batchLimit, offset) as EmbeddingRow[];

      if (rows.length === 0) break;

      for (const row of rows) {
        const embedding = new Float32Array(new Uint8Array(row.embedding).buffer);
        if (embedding.length !== EXPECTED_DIMENSIONS) {
          logger.warn(
            "searchVectorBruteForce",
            `Skipping row ${row.id}: embedding dimension ${embedding.length} !== ${EXPECTED_DIMENSIONS}`,
          );
          continue;
        }

        const similarity = EmbeddingModel.cosineSimilarity(queryEmbedding, embedding);
        scannedCount++;

        // Only insert if this candidate beats the current minimum in our top-K
        if (topK.length < limit) {
          topK.push({ memoryId: row.id, similarity });
          if (topK.length === limit) {
            // Sort and establish the min threshold
            topK.sort((a, b) => b.similarity - a.similarity);
            const last = topK[topK.length - 1];
            minTopKSimilarity = last ? last.similarity : -Infinity;
          }
        } else if (similarity > minTopKSimilarity) {
          // Replace the worst candidate
          topK[topK.length - 1] = { memoryId: row.id, similarity };
          topK.sort((a, b) => b.similarity - a.similarity);
          const last = topK[topK.length - 1];
          minTopKSimilarity = last ? last.similarity : -Infinity;
        }
      }
    }

    // Final sort (may already be sorted but ensure correctness)
    topK.sort((a, b) => b.similarity - a.similarity);

    if (scannedCount >= MAX_VECTOR_SCAN_ROWS) {
      logger.warn(
        "searchVectorBruteForce",
        `Scanned maximum ${MAX_VECTOR_SCAN_ROWS} rows; results may be incomplete. ` +
          `Consider installing sqlite-vec for ANN indexing.`,
      );
    }

    return Ok(topK);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Vector similarity search failed", cause));
  }
}

// ---------------------------------------------------------------------------
// Embedding storage
// ---------------------------------------------------------------------------

/** Store an embedding for a memory. Also updates the vec0 table if available. */
export function storeEmbedding(
  db: Database,
  memoryId: string,
  embedding: Float32Array,
  vec0Available: boolean,
  logger: Logger,
): Result<void, EidolonError> {
  try {
    const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    db.query("UPDATE memories SET embedding = ? WHERE id = ?").run(bytes, memoryId);

    // Also insert into the vec0 table for ANN search (if available)
    if (vec0Available) {
      try {
        // Get the rowid for this memory
        const row = db.query("SELECT rowid FROM memories WHERE id = ?").get(memoryId) as {
          rowid: number;
        } | null;

        if (row) {
          db.query(`INSERT OR REPLACE INTO ${VEC0_TABLE_NAME}(rowid, embedding) VALUES (?, ?)`).run(row.rowid, bytes);
        }
      } catch (cause) {
        // Non-fatal: vec0 sync failure should not block embedding storage
        logger.warn("storeEmbedding", "Failed to sync embedding to vec0 table", {
          memoryId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    return Ok(undefined);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to store embedding for memory ${memoryId}`, cause));
  }
}

/** Get the embedding for a memory. */
export function getEmbedding(
  db: Database,
  memoryId: string,
): Result<Float32Array | null, EidolonError> {
  try {
    const row = db.query("SELECT embedding FROM memories WHERE id = ?").get(memoryId) as {
      embedding: Uint8Array | null;
    } | null;

    if (!row || row.embedding === null) {
      return Ok(null);
    }

    const embedding = new Float32Array(new Uint8Array(row.embedding).buffer);
    return Ok(embedding);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get embedding for memory ${memoryId}`, cause));
  }
}
