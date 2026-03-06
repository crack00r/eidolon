/**
 * MemorySearch -- hybrid search combining BM25 full-text search (FTS5),
 * vector similarity search, graph expansion, and Reciprocal Rank Fusion
 * (RRF) to produce a single ranked result list.
 *
 * Search pipeline:
 *   1. BM25 search via FTS5 -> ranked list
 *   2. Vector search via cosine similarity -> ranked list
 *   3. Graph expansion from top results -> ranked list
 *   4. Fuse all lists with weighted RRF -> final ranked results
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Memory, MemorySearchQuery, MemorySearchResult, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import { EmbeddingModel } from "./embeddings.ts";
import type { GraphMemory } from "./graph.ts";
import type { MemoryStore } from "./store.ts";

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
 * Batch size for vector similarity scan. Rows are processed in chunks of
 * this size rather than loading all into memory at once. At 384 dims x 4
 * bytes x 2000 rows = ~3 MB per batch, a manageable working set.
 */
const VECTOR_SCAN_BATCH_SIZE = 2000;
/**
 * Maximum total rows scanned during vector similarity search.
 * Beyond this threshold, an ANN index (sqlite-vec) should be used.
 */
const MAX_VECTOR_SCAN_ROWS = 100_000;
/** Expected embedding dimension (must match EmbeddingModel output). */
const EXPECTED_DIMENSIONS = 384;
/** Number of top direct results to use as seeds for graph expansion. */
const GRAPH_EXPANSION_SEED_COUNT = 5;
/** Default graph walk depth for search expansion. */
const DEFAULT_GRAPH_WALK_DEPTH = 1;

// ---------------------------------------------------------------------------
// MemorySearch
// ---------------------------------------------------------------------------

export class MemorySearch {
  private readonly store: MemoryStore;
  private readonly embeddingModel: EmbeddingModel;
  private readonly logger: Logger;
  private readonly tracer: ITracer;
  private readonly bm25Weight: number;
  private readonly vectorWeight: number;
  private readonly graphWeight: number;
  private readonly rrfK: number;
  private readonly db: Database;
  private readonly graph: GraphMemory | null;

  constructor(
    store: MemoryStore,
    embeddingModel: EmbeddingModel,
    db: Database,
    logger: Logger,
    options?: MemorySearchOptions,
    tracer?: ITracer,
    graph?: GraphMemory,
  ) {
    this.store = store;
    this.embeddingModel = embeddingModel;
    this.db = db;
    this.logger = logger.child("memory-search");
    this.tracer = tracer ?? new NoopTracer();
    this.bm25Weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, options?.bm25Weight ?? DEFAULT_BM25_WEIGHT));
    this.vectorWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, options?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT));
    this.graphWeight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, options?.graphWeight ?? DEFAULT_GRAPH_WEIGHT));
    this.rrfK = Math.max(1, options?.rrfK ?? DEFAULT_RRF_K);
    this.graph = graph ?? null;
  }

  // -----------------------------------------------------------------------
  // Public: full hybrid search
  // -----------------------------------------------------------------------

  /** Full hybrid search: BM25 + vector + graph expansion + RRF fusion. */
  async search(query: MemorySearchQuery): Promise<Result<MemorySearchResult[], EidolonError>> {
    if (!query.text || query.text.trim().length === 0) {
      return Ok([]);
    }
    const searchSpan = this.tracer.startSpan("memory.search", {
      "query.length": query.text.length,
      "query.limit": query.limit ?? DEFAULT_LIMIT,
    });
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_SEARCH_LIMIT));

    // BM25 search
    const bm25Result = this.searchBm25(query.text, limit);
    if (!bm25Result.ok) {
      searchSpan.setStatus("error", "BM25 search failed");
      searchSpan.end();
      return bm25Result;
    }

    // Vector search -- requires embedding model to be initialised
    let vectorList: Array<{ memoryId: string; similarity: number }> = [];
    if (this.embeddingModel.isInitialized) {
      const embResult = await this.embeddingModel.embed(query.text, "query");
      if (!embResult.ok) {
        searchSpan.setStatus("error", "Embedding failed");
        searchSpan.end();
        return Err(embResult.error);
      }

      const vecResult = await this.searchVector(embResult.value, limit);
      if (!vecResult.ok) {
        searchSpan.setStatus("error", "Vector search failed");
        searchSpan.end();
        return vecResult;
      }
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

    // Graph expansion: walk edges from top direct results to find related memories
    const graphScoreMap = new Map<string, number>();
    if (this.graph !== null && this.graphWeight > 0 && query.includeGraph !== false) {
      const graphResult = this.expandViaGraph(bm25Ranked, vectorRanked, limit);
      if (graphResult.ok && graphResult.value.length > 0) {
        rankedLists.push(graphResult.value);
        weights.push(this.graphWeight);
        for (const item of graphResult.value) {
          graphScoreMap.set(item.id, item.rank);
        }
      }
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
      if (graphScoreMap.has(entry.id)) reasons.push("graph");

      results.push({
        memory,
        score: entry.score,
        bm25Score: bm25ScoreMap.get(entry.id),
        vectorScore: vectorScoreMap.get(entry.id),
        graphScore: graphScoreMap.has(entry.id) ? 1 / (this.rrfK + (graphScoreMap.get(entry.id) ?? 1)) : undefined,
        matchReason: reasons.join("+") || "unknown",
      });
    }

    this.logger.debug("search", `Hybrid search completed`, {
      bm25Count: bm25Ranked.length,
      vectorCount: vectorRanked.length,
      graphCount: graphScoreMap.size,
      fusedCount: fused.length,
      returnedCount: results.length,
    });

    searchSpan.setAttribute("results.bm25_count", bm25Ranked.length);
    searchSpan.setAttribute("results.vector_count", vectorRanked.length);
    searchSpan.setAttribute("results.graph_count", graphScoreMap.size);
    searchSpan.setAttribute("results.total", results.length);
    searchSpan.setStatus("ok");
    searchSpan.end();

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
   * Vector similarity search using batched scanning.
   *
   * Processes embeddings in batches of VECTOR_SCAN_BATCH_SIZE to limit peak
   * memory usage. Maintains a bounded top-K candidate list throughout the scan,
   * so only `limit` results are kept in memory at any time (plus the current batch).
   *
   * Scalability note: This is a brute-force scan bounded by MAX_VECTOR_SCAN_ROWS.
   * For memory stores exceeding this threshold, sqlite-vec should be used for
   * true ANN (approximate nearest neighbor) indexing. To migrate:
   *   1. Install sqlite-vec and load the extension
   *   2. Create a virtual table: CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[384])
   *   3. Replace this scan with: SELECT rowid, distance FROM memory_vec
   *      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
   *   4. sqlite-vec handles indexing and KNN search natively
   */
  async searchVector(
    queryEmbedding: Float32Array,
    limit: number,
  ): Promise<Result<Array<{ memoryId: string; similarity: number }>, EidolonError>> {
    try {
      // Count total rows to scan (for logging and progress tracking)
      const countRow = this.db.query("SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL").get() as {
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
        const rows = this.db
          .query("SELECT id, embedding FROM memories WHERE embedding IS NOT NULL ORDER BY rowid LIMIT ? OFFSET ?")
          .all(batchLimit, offset) as EmbeddingRow[];

        if (rows.length === 0) break;

        for (const row of rows) {
          const embedding = new Float32Array(new Uint8Array(row.embedding).buffer);
          if (embedding.length !== EXPECTED_DIMENSIONS) {
            this.logger.warn(
              "searchVector",
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
        this.logger.warn(
          "searchVector",
          `Scanned maximum ${MAX_VECTOR_SCAN_ROWS} rows; results may be incomplete. ` +
            `Consider installing sqlite-vec for ANN indexing.`,
        );
      }

      return Ok(topK);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Vector similarity search failed", cause));
    }
  }

  // -----------------------------------------------------------------------
  // Private: graph expansion
  // -----------------------------------------------------------------------

  /**
   * Expand search results via graph edges. Takes the top-N results from
   * BM25 and vector search as seeds, walks memory_edges to find connected
   * memories (1-hop by default), and returns them as a ranked list for
   * RRF fusion.
   *
   * Connected memories that already appear in direct results are excluded
   * from the graph ranked list (they already contribute via BM25/vector).
   * The graph walk weights (closer = higher) are used to rank the expanded
   * results.
   */
  private expandViaGraph(
    bm25Ranked: ReadonlyArray<{ id: string; rank: number }>,
    vectorRanked: ReadonlyArray<{ id: string; rank: number }>,
    limit: number,
  ): Result<Array<{ id: string; rank: number }>, EidolonError> {
    if (this.graph === null) {
      return Ok([]);
    }

    // Collect unique seed IDs from top-N of each direct result list
    const seedSet = new Set<string>();
    for (const item of bm25Ranked.slice(0, GRAPH_EXPANSION_SEED_COUNT)) {
      seedSet.add(item.id);
    }
    for (const item of vectorRanked.slice(0, GRAPH_EXPANSION_SEED_COUNT)) {
      seedSet.add(item.id);
    }

    if (seedSet.size === 0) {
      return Ok([]);
    }

    const seedIds = [...seedSet];

    // Walk the graph from seed nodes
    const walkResult = this.graph.graphWalk(seedIds, DEFAULT_GRAPH_WALK_DEPTH);
    if (!walkResult.ok) {
      this.logger.warn("expandViaGraph", "Graph walk failed; skipping graph expansion", {
        error: walkResult.error.message,
      });
      return Ok([]);
    }

    const walkResults = walkResult.value;
    if (walkResults.length === 0) {
      return Ok([]);
    }

    // Exclude IDs that already appear in direct results (they'll score via BM25/vector)
    const directIds = new Set<string>();
    for (const item of bm25Ranked) directIds.add(item.id);
    for (const item of vectorRanked) directIds.add(item.id);

    const graphOnly = walkResults.filter((r) => !directIds.has(r.memoryId));

    // The walkResults are already sorted by weight descending.
    // Convert to ranked list format for RRF (rank 1 = best).
    const ranked = graphOnly.slice(0, limit).map((item, idx) => ({
      id: item.memoryId,
      rank: idx + 1,
    }));

    this.logger.debug("expandViaGraph", `Graph expansion found ${ranked.length} additional memories`, {
      seeds: seedIds.length,
      walkTotal: walkResults.length,
      afterFilter: ranked.length,
    });

    return Ok(ranked);
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
