/**
 * PageRank -- compute entity importance scores for the Knowledge Graph.
 *
 * Iterative PageRank algorithm over kg_relations. Each entity starts with
 * uniform rank; on every iteration rank flows from each entity to its
 * outgoing neighbours, weighted by the number of outgoing edges.
 *
 * After convergence (or max iterations), the `importance` column on
 * kg_entities is updated in a single transaction.
 *
 * Reference: docs/design/MEMORY_ENGINE.md (PageRank for Entity Importance).
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageRankOptions {
  /** Damping factor (probability of following an edge). Default 0.85. */
  readonly dampingFactor?: number;
  /** Maximum number of iterations. Default 20. */
  readonly maxIterations?: number;
  /** Convergence threshold (max L1 change across all nodes). Default 0.001. */
  readonly convergenceThreshold?: number;
}

export interface PageRankResult {
  /** Number of entities ranked. */
  readonly entityCount: number;
  /** Number of relations used. */
  readonly relationCount: number;
  /** Actual iterations run before convergence or limit. */
  readonly iterations: number;
  /** Whether the algorithm converged within the threshold. */
  readonly converged: boolean;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface EntityIdRow {
  readonly id: string;
}

interface RelationEdgeRow {
  readonly source_id: string;
  readonly target_id: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAMPING_FACTOR = 0.85;
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_CONVERGENCE_THRESHOLD = 0.001;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute PageRank for all KG entities and persist the results.
 *
 * The algorithm:
 * 1. Initialise every entity with rank = 1/N.
 * 2. For each iteration, compute new ranks:
 *      rank'(v) = (1 - d) / N + d * SUM( rank(u) / outDegree(u) )
 *    where the sum is over all entities u that link to v.
 * 3. Check convergence: if the L1 norm of the rank change vector is below
 *    the threshold, stop early.
 * 4. Write final ranks to kg_entities.importance in one transaction.
 */
export function computePageRank(
  db: Database,
  logger: Logger,
  options?: PageRankOptions,
): Result<PageRankResult, EidolonError> {
  const dampingFactor = options?.dampingFactor ?? DEFAULT_DAMPING_FACTOR;
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const convergenceThreshold = options?.convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD;

  try {
    // 1. Load entity IDs
    const entityRows = db.query("SELECT id FROM kg_entities").all() as EntityIdRow[];
    const entityCount = entityRows.length;

    if (entityCount === 0) {
      logger.debug("pagerank", "No entities found, nothing to rank");
      return Ok({ entityCount: 0, relationCount: 0, iterations: 0, converged: true });
    }

    // Build entity-index lookup for fast array access
    const entityIds: string[] = entityRows.map((r) => r.id);
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < entityIds.length; i++) {
      const id = entityIds[i];
      if (id !== undefined) {
        idToIndex.set(id, i);
      }
    }

    // 2. Load relations and build adjacency structures
    const relationRows = db
      .query(
        `SELECT source_id, target_id FROM kg_relations
         WHERE confidence > 0`,
      )
      .all() as RelationEdgeRow[];

    const relationCount = relationRows.length;

    // inLinks[v] = list of entity indices u such that u -> v
    const inLinks: number[][] = Array.from({ length: entityCount }, () => []);
    // outDegree[u] = number of outgoing edges from u
    const outDegree = new Float64Array(entityCount);

    for (const rel of relationRows) {
      const srcIdx = idToIndex.get(rel.source_id);
      const tgtIdx = idToIndex.get(rel.target_id);
      // Skip edges pointing to entities not in the entity set (should not happen
      // with FK constraints, but be defensive)
      if (srcIdx === undefined || tgtIdx === undefined) continue;

      inLinks[tgtIdx]?.push(srcIdx);
      outDegree[srcIdx] = (outDegree[srcIdx] ?? 0) + 1;
    }

    // 3. Initialise ranks uniformly
    const initialRank = 1.0 / entityCount;
    let ranks = new Float64Array(entityCount).fill(initialRank);

    const teleportValue = (1 - dampingFactor) / entityCount;
    let iterations = 0;
    let converged = false;

    // 4. Iterate
    for (let iter = 0; iter < maxIterations; iter++) {
      iterations = iter + 1;
      const newRanks = new Float64Array(entityCount).fill(teleportValue);

      // Accumulate rank contributions from incoming links
      for (let v = 0; v < entityCount; v++) {
        const incoming = inLinks[v];
        if (!incoming) continue;
        for (const u of incoming) {
          const degree = outDegree[u];
          if (degree !== undefined && degree > 0) {
            const currentRank = ranks[u];
            if (currentRank !== undefined) {
              const existing = newRanks[v] ?? 0;
              newRanks[v] = existing + dampingFactor * (currentRank / degree);
            }
          }
        }
      }

      // Handle dangling nodes (nodes with no outgoing edges):
      // Their rank "leaks" out; redistribute it uniformly.
      let danglingSum = 0;
      for (let u = 0; u < entityCount; u++) {
        if ((outDegree[u] ?? 0) === 0) {
          danglingSum += ranks[u] ?? 0;
        }
      }
      if (danglingSum > 0) {
        const danglingContribution = (dampingFactor * danglingSum) / entityCount;
        for (let v = 0; v < entityCount; v++) {
          const existing = newRanks[v] ?? 0;
          newRanks[v] = existing + danglingContribution;
        }
      }

      // Check convergence (L1 norm of delta)
      let delta = 0;
      for (let v = 0; v < entityCount; v++) {
        delta += Math.abs((newRanks[v] ?? 0) - (ranks[v] ?? 0));
      }

      ranks = newRanks;

      if (delta < convergenceThreshold) {
        converged = true;
        break;
      }
    }

    // 5. Persist ranks to kg_entities.importance in one transaction
    const updateStmt = db.prepare("UPDATE kg_entities SET importance = ? WHERE id = ?");

    const writeRanks = db.transaction(() => {
      for (let i = 0; i < entityCount; i++) {
        const id = entityIds[i];
        const rank = ranks[i];
        if (id !== undefined && rank !== undefined) {
          updateStmt.run(rank, id);
        }
      }
    });

    writeRanks();

    logger.info("pagerank", `PageRank computed for ${entityCount} entities`, {
      iterations,
      converged,
      relationCount,
    });

    return Ok({ entityCount, relationCount, iterations, converged });
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to compute PageRank", cause));
  }
}
