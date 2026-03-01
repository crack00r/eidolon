/**
 * GraphMemory -- edge management and graph-walk expansion for memory.db.
 *
 * Manages relationships (edges) between memories in the `memory_edges` table.
 * Provides graph-walk expansion to enrich search results by discovering
 * related memories through multi-hop traversal.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, MemoryEdge, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EdgeRelation = "related_to" | "contradicts" | "refines" | "depends_on" | "supersedes";

export interface CreateEdgeInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relation: EdgeRelation;
  readonly weight?: number;
}

export interface GraphWalkResult {
  readonly memoryId: string;
  readonly weight: number;
}

// ---------------------------------------------------------------------------
// Internal row shape from SQLite
// ---------------------------------------------------------------------------

interface EdgeRow {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation: string;
  readonly weight: number;
  readonly created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation,
    weight: row.weight,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// GraphMemory
// ---------------------------------------------------------------------------

export class GraphMemory {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("graph-memory");
  }

  /** Create an edge between two memories. Upsert: if edge exists, update weight. */
  createEdge(input: CreateEdgeInput): Result<MemoryEdge, EidolonError> {
    try {
      const now = Date.now();
      const weight = input.weight ?? 1.0;

      this.db
        .query(
          `INSERT INTO memory_edges (source_id, target_id, relation, weight, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source_id, target_id, relation)
           DO UPDATE SET weight = ?, created_at = ?`,
        )
        .run(input.sourceId, input.targetId, input.relation, weight, now, weight, now);

      const edge: MemoryEdge = {
        sourceId: input.sourceId,
        targetId: input.targetId,
        relation: input.relation,
        weight,
        createdAt: now,
      };

      this.logger.debug("createEdge", `Created edge ${input.sourceId} -[${input.relation}]-> ${input.targetId}`, {
        weight,
      });
      return Ok(edge);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create edge", cause));
    }
  }

  /** Get all edges FROM a memory. */
  getOutgoing(memoryId: string): Result<MemoryEdge[], EidolonError> {
    try {
      const rows = this.db.query("SELECT * FROM memory_edges WHERE source_id = ?").all(memoryId) as EdgeRow[];
      return Ok(rows.map(rowToEdge));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get outgoing edges for ${memoryId}`, cause));
    }
  }

  /** Get all edges TO a memory. */
  getIncoming(memoryId: string): Result<MemoryEdge[], EidolonError> {
    try {
      const rows = this.db.query("SELECT * FROM memory_edges WHERE target_id = ?").all(memoryId) as EdgeRow[];
      return Ok(rows.map(rowToEdge));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get incoming edges for ${memoryId}`, cause));
    }
  }

  /** Get all edges (incoming + outgoing) for a memory. */
  getAll(memoryId: string): Result<MemoryEdge[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM memory_edges WHERE source_id = ? OR target_id = ?")
        .all(memoryId, memoryId) as EdgeRow[];
      return Ok(rows.map(rowToEdge));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get edges for ${memoryId}`, cause));
    }
  }

  /** Delete an edge. */
  deleteEdge(sourceId: string, targetId: string, relation: string): Result<void, EidolonError> {
    try {
      this.db
        .query("DELETE FROM memory_edges WHERE source_id = ? AND target_id = ? AND relation = ?")
        .run(sourceId, targetId, relation);
      this.logger.debug("deleteEdge", `Deleted edge ${sourceId} -[${relation}]-> ${targetId}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to delete edge", cause));
    }
  }

  /** Delete all edges for a memory (when memory is deleted). */
  deleteAllForMemory(memoryId: string): Result<number, EidolonError> {
    try {
      const countRow = this.db
        .query("SELECT COUNT(*) as count FROM memory_edges WHERE source_id = ? OR target_id = ?")
        .get(memoryId, memoryId) as { count: number };
      const count = countRow.count;

      if (count > 0) {
        this.db.query("DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?").run(memoryId, memoryId);
      }

      this.logger.debug("deleteAllForMemory", `Deleted ${count} edges for memory ${memoryId}`);
      return Ok(count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete edges for ${memoryId}`, cause));
    }
  }

  /**
   * Graph-walk expansion: starting from a set of seed memory IDs,
   * walk the graph up to `depth` hops and return all reachable memory IDs
   * with their accumulated weights (closer = higher weight).
   *
   * Used to expand search results: if BM25+vector finds "Tailscale",
   * graph walk also returns connected memories about "GPU worker", "VPN", etc.
   */
  graphWalk(seedIds: readonly string[], depth: number = 1): Result<GraphWalkResult[], EidolonError> {
    try {
      const visited = new Map<string, number>();
      let frontier: Array<{ id: string; weight: number }> = [];

      for (const seed of seedIds) {
        visited.set(seed, 1.0);
        frontier.push({ id: seed, weight: 1.0 });
      }

      for (let d = 0; d < depth; d++) {
        const nextFrontier: Array<{ id: string; weight: number }> = [];

        for (const { id, weight } of frontier) {
          const edges = this.getAll(id);
          if (!edges.ok) continue;

          for (const edge of edges.value) {
            const neighborId = edge.sourceId === id ? edge.targetId : edge.sourceId;
            const newWeight = weight * edge.weight * 0.5; // Decay by 50% per hop

            const currentWeight = visited.get(neighborId);
            if (currentWeight === undefined || currentWeight < newWeight) {
              visited.set(neighborId, newWeight);
              nextFrontier.push({ id: neighborId, weight: newWeight });
            }
          }
        }

        frontier = nextFrontier;
      }

      // Remove seed IDs from results (they're already in the direct search results)
      for (const seed of seedIds) {
        visited.delete(seed);
      }

      const results = [...visited.entries()]
        .map(([memoryId, weight]) => ({ memoryId, weight }))
        .sort((a, b) => b.weight - a.weight);

      this.logger.debug("graphWalk", `Walk from ${seedIds.length} seeds at depth ${depth}`, {
        resultCount: results.length,
      });
      return Ok(results);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Graph walk failed", cause));
    }
  }

  /** Strengthen an edge (increase weight, capped at 1.0). Used during dreaming re-discovery. */
  strengthenEdge(sourceId: string, targetId: string, relation: string, amount: number): Result<void, EidolonError> {
    try {
      this.db
        .query(
          `UPDATE memory_edges
           SET weight = MIN(weight + ?, 1.0)
           WHERE source_id = ? AND target_id = ? AND relation = ?`,
        )
        .run(amount, sourceId, targetId, relation);
      this.logger.debug("strengthenEdge", `Strengthened edge ${sourceId} -[${relation}]-> ${targetId}`, { amount });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to strengthen edge", cause));
    }
  }

  /** Decay all edge weights by a factor. Used during housekeeping. */
  decayWeights(factor: number): Result<number, EidolonError> {
    try {
      // Apply decay to all edges, then prune those below threshold
      this.db.query("UPDATE memory_edges SET weight = weight * ?").run(factor);

      // Delete edges that fell below threshold
      const deleteResult = this.db.query("DELETE FROM memory_edges WHERE weight < 0.01").run();
      const deleted = deleteResult.changes;

      // Count remaining edges
      const countRow = this.db.query("SELECT COUNT(*) as count FROM memory_edges").get() as { count: number };

      this.logger.debug("decayWeights", `Decayed weights by factor ${factor}`, {
        deleted,
        remaining: countRow.count,
      });
      return Ok(deleted);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to decay edge weights", cause));
    }
  }

  /** Count total edges. */
  count(): Result<number, EidolonError> {
    try {
      const row = this.db.query("SELECT COUNT(*) as count FROM memory_edges").get() as { count: number };
      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count edges", cause));
    }
  }
}
