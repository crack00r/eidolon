/**
 * MemorySearch -- hybrid search combining BM25 full-text search (FTS5),
 * vector similarity search, and Reciprocal Rank Fusion (RRF) to produce
 * a single ranked result list.
 *
 * Search pipeline:
 *   1. BM25 search via FTS5 -> ranked list
 *   2. Vector search via cosine similarity -> ranked list
 *   3. Graph expansion (Step 2.5, placeholder) -> bonus scores
 *   4. Fuse with RRF -> final ranked results
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Memory, MemorySearchQuery, MemorySearchResult, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";
import { EmbeddingModel } from "./embeddings.js";
import type { MemoryStore } from "./store.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MemorySearchOptions {
  readonly bm25Weight?: number;
  readonly vectorWeight?: number;
  readonly graphWeight?: number;
  readonly rrfK?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface EmbeddingRow {
  readonly id: string;
  readonly embedding: Uint8Array;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BM25_WEIGHT = 0.4;
const DEFAULT_VECTOR_WEIGHT = 0.4;
const DEFAULT_GRAPH_WEIGHT = 0.2;
const DEFAULT_RRF_K = 60;
const DEFAULT_LIMIT = 20;
/** Maximum allowed search limit to prevent excessive memory usage. */
const MAX_SEARCH_LIMIT = 1000;
/** Minimum weight value for search weights (must be non-negative). */
const MIN_WEIGHT = 0;
/** Maximum weight value for search weights. */
const MAX_WEIGHT = 1.0;
/**
 * Upper bound on rows scanned during vector similarity search to prevent OOM.
 * Set to 10,000 as a balance between recall quality and memory usage.
 * For stores larger than this, migrate to sqlite-vec for ANN indexing.
 * At 384 dimensions × 4 bytes × 10,000 rows ≈ 15 MB peak memory.
 */
const MAX_VECTOR_SCAN_ROWS = 10_000;

// ---------------------------------------------------------------------------
// MemorySearch
// ---------------------------------------------------------------------------

export class MemorySearch {
  private readonly store: MemoryStore;
  private readonly embeddingModel: EmbeddingModel;
  private readonly logger: Logger;
  private readonly bm25Weight: number;
  private readonly vectorWeight: number;
  private readonly graphWeight: number;
  private readonly rrfK: number;
  private readonly db: Database;

  constructor(
    store: MemoryStore,
    embeddingModel: EmbeddingModel,
    db: Database,
    logger: Logger,
    options?: MemorySearchOptions,
  ) {
    this.store = store;
    this.embeddingModel = embeddingModel;
    this.db = db;
    this.logger = logger.child("memory-search");
    this.bm25Weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, options?.bm25Weight ?? DEFAULT_BM25_WEIGHT));
    this.vectorWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, options?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT));
    this.graphWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, options?.graphWeight ?? DEFAULT_GRAPH_WEIGHT));
    this.rrfK = Math.max(1, options?.rrfK ?? DEFAULT_RRF_K);
  }

  // -----------------------------------------------------------------------
  // Public: full hybrid search
  // -----------------------------------------------------------------------

  /** Full hybrid search: BM25 + vector + RRF fusion. */
  async search(query: MemorySearchQuery): Promise<Result<MemorySearchResult[], EidolonError>> {
    if (!query.text || query.text.trim().length === 0) {
      return Ok([]);
    }
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_SEARCH_LIMIT));

    // BM25 search
    const bm25Result = this.searchBm25(query.text, limit);
    if (!bm25Result.ok) return bm25Result;

    // Vector search -- requires embedding model to be initialised
    let vectorList: Array<{ memoryId: string; similarity: number }> = [];
    if (this.embeddingModel.isInitialized) {
      const embResult = await this.embeddingModel.embed(query.text, "query");
      if (!embResult.ok) return Err(embResult.error);

      const vecResult = await this.searchVector(embResult.value, limit);
      if (!vecResult.ok) return vecResult;
      vectorList = vecResult.value;
    } else {
      this.logger.warn("search", "Embedding model not initialized; skipping vector search");
    }

    // Build ranked lists for RRF
    const bm25Ranked = bm25Result.value.map((item, idx) => ({
      id: item.memoryId,
      rank: idx + 1,
    }));
    const vectorRanked = vectorList.map((item, idx) => ({
      id: item.memoryId,
      rank: idx + 1,
    }));

    const rankedLists: Array<ReadonlyArray<{ id: string; rank: number }>> = [];
    const weights: number[] = [];

    if (bm25Ranked.length > 0) {
      rankedLists.push(bm25Ranked);
      weights.push(this.bm25Weight);
    }
    if (vectorRanked.length > 0) {
      rankedLists.push(vectorRanked);
      weights.push(this.vectorWeight);
    }

    // Fuse
    const fused = MemorySearch.fuseRRF(rankedLists, weights, this.rrfK);

    // Build score lookup maps for individual scores
    const bm25ScoreMap = new Map<string, number>();
    for (const item of bm25Result.value) {
      bm25ScoreMap.set(item.memoryId, item.rank);
    }
    const vectorScoreMap = new Map<string, number>();
    for (const item of vectorList) {
      vectorScoreMap.set(item.memoryId, item.similarity);
    }

    // Fetch Memory objects for the top results and apply filters
    const results: MemorySearchResult[] = [];
    for (const entry of fused) {
      if (results.length >= limit) break;

      const memResult = this.store.get(entry.id);
      if (!memResult.ok) continue;
      if (memResult.value === null) continue;

      const memory: Memory = memResult.value;

      // Apply filters
      if (query.types && query.types.length > 0) {
        if (!query.types.includes(memory.type)) continue;
      }
      if (query.layers && query.layers.length > 0) {
        if (!query.layers.includes(memory.layer)) continue;
      }
      if (query.minConfidence !== undefined && memory.confidence < query.minConfidence) {
        continue;
      }
      if (query.tags && query.tags.length > 0) {
        const memTags = new Set(memory.tags);
        if (!query.tags.some((t) => memTags.has(t))) continue;
      }

      // Determine match reason
      const reasons: string[] = [];
      if (bm25ScoreMap.has(entry.id)) reasons.push("bm25");
      if (vectorScoreMap.has(entry.id)) reasons.push("vector");

      results.push({
        memory,
        score: entry.score,
        bm25Score: bm25ScoreMap.get(entry.id),
        vectorScore: vectorScoreMap.get(entry.id),
        matchReason: reasons.join("+") || "unknown",
      });
    }

    this.logger.debug("search", `Hybrid search completed`, {
      bm25Count: bm25Ranked.length,
      vectorCount: vectorRanked.length,
      fusedCount: fused.length,
      returnedCount: results.length,
    });

    return Ok(results);
  }

  // -----------------------------------------------------------------------
  // Public: BM25 text search
  // -----------------------------------------------------------------------

  /** BM25 text search only (via FTS5). */
  searchBm25(query: string, limit: number): Result<Array<{ memoryId: string; rank: number }>, EidolonError> {
    const storeResult = this.store.searchText(query, limit);
    if (!storeResult.ok) return storeResult;

    const ranked = storeResult.value.map((item) => ({
      memoryId: item.memory.id,
      rank: item.rank,
    }));

    return Ok(ranked);
  }

  // -----------------------------------------------------------------------
  // Public: vector similarity search
  // -----------------------------------------------------------------------

  /**
   * Vector similarity search.
   *
   * Performance note: This performs a full table scan of all embeddings and
   * computes cosine similarity in application code. For large memory stores
   * (>100k memories), consider migrating to sqlite-vec for ANN indexing.
   * The scan is bounded by MAX_VECTOR_SCAN_ROWS to prevent excessive memory use.
   */
  async searchVector(
    queryEmbedding: Float32Array,
    limit: number,
  ): Promise<Result<Array<{ memoryId: string; similarity: number }>, EidolonError>> {
    try {
      // Cap the number of rows scanned to prevent unbounded memory usage.
      // This is a reasonable upper bound; if the memory store grows beyond this,
      // an ANN index (sqlite-vec) should be used instead.
      const rows = this.db
        .query("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL LIMIT ?")
        .all(MAX_VECTOR_SCAN_ROWS) as EmbeddingRow[];

      const scored: Array<{ memoryId: string; similarity: number }> = [];

      /** Expected embedding dimension (must match EmbeddingModel output). */
      const EXPECTED_DIMENSIONS = 384;

      for (const row of rows) {
        const embedding = new Float32Array(new Uint8Array(row.embedding).buffer);
        // Skip rows with wrong embedding dimensions (corrupted or schema-mismatched data)
        if (embedding.length !== EXPECTED_DIMENSIONS) {
          this.logger.warn(
            "searchVector",
            `Skipping row ${row.id}: embedding dimension ${embedding.length} !== ${EXPECTED_DIMENSIONS}`,
          );
          continue;
        }
        const similarity = EmbeddingModel.cosineSimilarity(queryEmbedding, embedding);
        scored.push({ memoryId: row.id, similarity });
      }

      // Sort descending by similarity
      scored.sort((a, b) => b.similarity - a.similarity);

      return Ok(scored.slice(0, limit));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Vector similarity search failed", cause));
    }
  }

  // -----------------------------------------------------------------------
  // Public static: Reciprocal Rank Fusion
  // -----------------------------------------------------------------------

  /**
   * Reciprocal Rank Fusion to combine ranked lists.
   * Formula: score = Σ weight_i * 1/(k + rank_i)
   */
  static fuseRRF(
    rankedLists: ReadonlyArray<ReadonlyArray<{ id: string; rank: number }>>,
    weights: readonly number[],
    k: number,
  ): Array<{ id: string; score: number }> {
    const scoreMap = new Map<string, number>();

    for (let i = 0; i < rankedLists.length; i++) {
      const list = rankedLists[i];
      const weight = weights[i] ?? 1;
      if (!list) continue;

      for (const item of list) {
        const rrfScore = weight * (1 / (k + item.rank));
        const current = scoreMap.get(item.id) ?? 0;
        scoreMap.set(item.id, current + rrfScore);
      }
    }

    const results: Array<{ id: string; score: number }> = [];
    for (const [id, score] of scoreMap) {
      results.push({ id, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // -----------------------------------------------------------------------
  // Public: embedding storage
  // -----------------------------------------------------------------------

  /** Store an embedding for a memory. */
  storeEmbedding(memoryId: string, embedding: Float32Array): Result<void, EidolonError> {
    try {
      const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      this.db.query("UPDATE memories SET embedding = ? WHERE id = ?").run(bytes, memoryId);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to store embedding for memory ${memoryId}`, cause));
    }
  }

  /** Get the embedding for a memory. */
  getEmbedding(memoryId: string): Result<Float32Array | null, EidolonError> {
    try {
      const row = this.db.query("SELECT embedding FROM memories WHERE id = ?").get(memoryId) as {
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
}
