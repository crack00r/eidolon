/**
 * MemorySearch -- hybrid search combining BM25 full-text search (FTS5),
 * vector similarity search, graph expansion, and Reciprocal Rank Fusion
 * (RRF) to produce a single ranked result list.
 *
 * Search pipeline:
 *   1. BM25 search via FTS5 -> ranked list
 *   2. Vector search via sqlite-vec ANN (with brute-force fallback) -> ranked list
 *   3. Graph expansion from top results -> ranked list
 *   4. Fuse all lists with weighted RRF -> final ranked results
 *
 * Vector search strategy:
 *   - Primary: sqlite-vec vec0 virtual table with native KNN via MATCH operator
 *   - Fallback: brute-force cosine similarity scan (used when sqlite-vec extension
 *     is not loaded or the vec0 table cannot be created)
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

/** Row returned from sqlite-vec KNN query. */
interface Vec0KnnRow {
  readonly rowid: number;
  readonly distance: number;
}

/** Mapping row for rowid -> memory id lookup. */
interface RowIdMapping {
  readonly rowid: number;
  readonly id: string;
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
/** Number of top direct results to use as seeds for graph expansion. */
const GRAPH_EXPANSION_SEED_COUNT = 5;
/** Default graph walk depth for search expansion. */
const DEFAULT_GRAPH_WALK_DEPTH = 1;
/** Name of the sqlite-vec virtual table for memory embeddings. */
const VEC0_TABLE_NAME = "memory_embeddings";

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
  /** Whether the sqlite-vec vec0 virtual table is available for ANN search. */
  private vec0Available = false;

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

    // Attempt to initialise the sqlite-vec vec0 table on construction
    this.initVec0Table();
  }

  // -----------------------------------------------------------------------
  // Private: sqlite-vec initialisation
  // -----------------------------------------------------------------------

  /**
   * Attempt to create the sqlite-vec vec0 virtual table for ANN search.
   *
   * If the sqlite-vec extension is not loaded, the CREATE VIRTUAL TABLE
   * statement will throw and we silently fall back to brute-force scanning.
   * This makes sqlite-vec an optional performance optimisation rather than
   * a hard dependency.
   */
  private initVec0Table(): void {
    try {
      // Check if table already exists
      const existing = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(VEC0_TABLE_NAME) as { name: string } | null;

      if (existing) {
        // Table exists -- verify we can query it (extension might have been
        // loaded when the table was created but not in this session)
        try {
          this.db.query(`SELECT rowid FROM ${VEC0_TABLE_NAME} LIMIT 0`).all();
          this.vec0Available = true;
          this.logger.info("initVec0", "sqlite-vec vec0 table available for ANN search");
          return;
        } catch {
          // Table exists but cannot be queried (extension not loaded)
          this.logger.warn(
            "initVec0",
            `${VEC0_TABLE_NAME} table exists but sqlite-vec extension not loaded; falling back to brute-force`,
          );
          this.vec0Available = false;
          return;
        }
      }

      // Try to create the vec0 table (requires sqlite-vec extension)
      this.db.run(`CREATE VIRTUAL TABLE ${VEC0_TABLE_NAME} USING vec0(embedding float[${EXPECTED_DIMENSIONS}])`);
      this.vec0Available = true;
      this.logger.info("initVec0", "Created sqlite-vec vec0 table for ANN search");

      // Backfill existing embeddings from the memories table
      this.backfillVec0Table();
    } catch {
      // sqlite-vec extension not available -- use brute-force fallback
      this.vec0Available = false;
      this.logger.info("initVec0", "sqlite-vec extension not available; using brute-force vector search fallback");
    }
  }

  /**
   * Backfill the vec0 table from existing embeddings in the memories table.
   * Called once when the vec0 table is first created on an existing database.
   */
  private backfillVec0Table(): void {
    try {
      const rows = this.db.query("SELECT rowid, embedding FROM memories WHERE embedding IS NOT NULL").all() as Array<{
        rowid: number;
        embedding: Uint8Array;
      }>;

      if (rows.length === 0) return;

      const insertStmt = this.db.prepare(`INSERT OR REPLACE INTO ${VEC0_TABLE_NAME}(rowid, embedding) VALUES (?, ?)`);
      const transaction = this.db.transaction(() => {
        for (const row of rows) {
          insertStmt.run(row.rowid, row.embedding);
        }
      });
      transaction();

      this.logger.info("backfillVec0", `Backfilled ${rows.length} embeddings into vec0 table`);
    } catch (cause) {
      this.logger.warn("backfillVec0", "Failed to backfill vec0 table", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /** Whether sqlite-vec ANN search is available. */
  get isVec0Available(): boolean {
    return this.vec0Available;
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
   * Vector similarity search. Uses sqlite-vec ANN indexing when the vec0
   * virtual table is available, otherwise falls back to brute-force cosine
   * similarity scanning.
   *
   * sqlite-vec path (preferred):
   *   Uses the `memory_embeddings` vec0 virtual table with the MATCH operator
   *   for efficient KNN search. The query vector is passed as a Float32Array
   *   blob and results are ordered by L2 distance.
   *
   * Brute-force fallback:
   *   Processes embeddings in batches of VECTOR_SCAN_BATCH_SIZE to limit peak
   *   memory usage. Bounded by MAX_VECTOR_SCAN_ROWS.
   */
  async searchVector(
    queryEmbedding: Float32Array,
    limit: number,
  ): Promise<Result<Array<{ memoryId: string; similarity: number }>, EidolonError>> {
    if (this.vec0Available) {
      return this.searchVectorVec0(queryEmbedding, limit);
    }
    return this.searchVectorBruteForce(queryEmbedding, limit);
  }

  // -----------------------------------------------------------------------
  // Private: sqlite-vec ANN search
  // -----------------------------------------------------------------------

  /**
   * Vector similarity search using sqlite-vec's native KNN via the MATCH
   * operator on the vec0 virtual table.
   *
   * sqlite-vec returns results ordered by L2 distance. We convert distance
   * to a similarity score using `1 / (1 + distance)` which maps distance=0
   * to similarity=1 and larger distances to values approaching 0.
   */
  private searchVectorVec0(
    queryEmbedding: Float32Array,
    limit: number,
  ): Result<Array<{ memoryId: string; similarity: number }>, EidolonError> {
    try {
      // sqlite-vec expects the query vector as a raw byte buffer
      const queryBlob = new Uint8Array(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);

      // KNN query via sqlite-vec MATCH operator
      // Returns rowid + distance ordered by distance ascending (closest first)
      const rows = this.db
        .query(`SELECT rowid, distance FROM ${VEC0_TABLE_NAME} WHERE embedding MATCH ? AND k = ?`)
        .all(queryBlob, limit) as Vec0KnnRow[];

      if (rows.length === 0) {
        return Ok([]);
      }

      // Map rowids back to memory IDs via the memories table
      const rowids = rows.map((r) => r.rowid);
      const placeholders = rowids.map(() => "?").join(",");
      const idRows = this.db
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

      this.logger.debug("searchVectorVec0", `ANN search returned ${results.length} results`, {
        limit,
        returnedCount: results.length,
      });

      return Ok(results);
    } catch (cause) {
      // If vec0 query fails at runtime (e.g. extension unloaded), fall back
      this.logger.warn("searchVectorVec0", "sqlite-vec ANN query failed; falling back to brute-force", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      this.vec0Available = false;
      return this.searchVectorBruteForce(queryEmbedding, limit);
    }
  }

  // -----------------------------------------------------------------------
  // Private: brute-force vector search (fallback)
  // -----------------------------------------------------------------------

  /**
   * Brute-force vector similarity search via batched cosine similarity
   * scanning. Used as fallback when sqlite-vec is not available.
   */
  private searchVectorBruteForce(
    queryEmbedding: Float32Array,
    limit: number,
  ): Result<Array<{ memoryId: string; similarity: number }>, EidolonError> {
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
        this.logger.warn(
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

  /** Store an embedding for a memory. Also updates the vec0 table if available. */
  storeEmbedding(memoryId: string, embedding: Float32Array): Result<void, EidolonError> {
    try {
      const bytes = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      this.db.query("UPDATE memories SET embedding = ? WHERE id = ?").run(bytes, memoryId);

      // Also insert into the vec0 table for ANN search (if available)
      if (this.vec0Available) {
        try {
          // Get the rowid for this memory
          const row = this.db.query("SELECT rowid FROM memories WHERE id = ?").get(memoryId) as {
            rowid: number;
          } | null;

          if (row) {
            this.db
              .query(`INSERT OR REPLACE INTO ${VEC0_TABLE_NAME}(rowid, embedding) VALUES (?, ?)`)
              .run(row.rowid, bytes);
          }
        } catch (cause) {
          // Non-fatal: vec0 sync failure should not block embedding storage
          this.logger.warn("storeEmbedding", "Failed to sync embedding to vec0 table", {
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
