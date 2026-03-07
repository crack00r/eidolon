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
import { Err, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import type { EmbeddingModel } from "./embeddings.ts";
import type { GraphMemory } from "./graph.ts";
import { expandViaGraph, fuseRRF } from "./search-fusion.ts";
import {
  getEmbedding,
  initVec0Table,
  searchVectorBruteForce,
  searchVectorVec0,
  storeEmbedding,
} from "./search-vector.ts";
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
    this.vec0Available = initVec0Table(this.db, this.logger);
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
      const graphResult = expandViaGraph(this.graph, bm25Ranked, vectorRanked, limit, this.logger);
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
   */
  async searchVector(
    queryEmbedding: Float32Array,
    limit: number,
  ): Promise<Result<Array<{ memoryId: string; similarity: number }>, EidolonError>> {
    if (this.vec0Available) {
      return searchVectorVec0(this.db, queryEmbedding, limit, this.logger, () => {
        this.vec0Available = false;
      });
    }
    return searchVectorBruteForce(this.db, queryEmbedding, limit, this.logger);
  }

  // -----------------------------------------------------------------------
  // Public static: Reciprocal Rank Fusion
  // -----------------------------------------------------------------------

  /**
   * Reciprocal Rank Fusion to combine ranked lists.
   * Formula: score = sum weight_i * 1/(k + rank_i)
   */
  static fuseRRF(
    rankedLists: ReadonlyArray<ReadonlyArray<{ id: string; rank: number }>>,
    weights: readonly number[],
    k: number,
  ): Array<{ id: string; score: number }> {
    return fuseRRF(rankedLists, weights, k);
  }

  // -----------------------------------------------------------------------
  // Public: embedding storage
  // -----------------------------------------------------------------------

  /** Store an embedding for a memory. Also updates the vec0 table if available. */
  storeEmbedding(memoryId: string, embedding: Float32Array): Result<void, EidolonError> {
    return storeEmbedding(this.db, memoryId, embedding, this.vec0Available, this.logger);
  }

  /** Get the embedding for a memory. */
  getEmbedding(memoryId: string): Result<Float32Array | null, EidolonError> {
    return getEmbedding(this.db, memoryId);
  }
}
