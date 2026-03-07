/**
 * Reciprocal Rank Fusion (RRF) and graph expansion for MemorySearch.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { GraphMemory } from "./graph.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of top direct results to use as seeds for graph expansion. */
const GRAPH_EXPANSION_SEED_COUNT = 5;
/** Default graph walk depth for search expansion. */
const DEFAULT_GRAPH_WALK_DEPTH = 1;

// ---------------------------------------------------------------------------
// RRF fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion to combine ranked lists.
 * Formula: score = sum weight_i * 1/(k + rank_i)
 */
export function fuseRRF(
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

// ---------------------------------------------------------------------------
// Graph expansion
// ---------------------------------------------------------------------------

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
export function expandViaGraph(
  graph: GraphMemory | null,
  bm25Ranked: ReadonlyArray<{ id: string; rank: number }>,
  vectorRanked: ReadonlyArray<{ id: string; rank: number }>,
  limit: number,
  logger: Logger,
): Result<Array<{ id: string; rank: number }>, EidolonError> {
  if (graph === null) {
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
  const walkResult = graph.graphWalk(seedIds, DEFAULT_GRAPH_WALK_DEPTH);
  if (!walkResult.ok) {
    logger.warn("expandViaGraph", "Graph walk failed; skipping graph expansion", {
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

  logger.debug("expandViaGraph", `Graph expansion found ${ranked.length} additional memories`, {
    seeds: seedIds.length,
    walkTotal: walkResults.length,
    afterFilter: ranked.length,
  });

  return Ok(ranked);
}
