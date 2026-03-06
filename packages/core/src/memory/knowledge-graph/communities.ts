/**
 * CommunityDetector -- Louvain-style community detection on the Knowledge Graph.
 *
 * Detects communities of densely connected entities using the Louvain algorithm
 * (implemented in louvain.ts) and persists results to the kg_communities table.
 *
 * All public methods return Result<T, EidolonError>.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, KGCommunity, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { buildAdjacencyGraph, louvainPhase1 } from "./louvain.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommunityDetectorOptions {
  /** Resolution parameter: higher = more granular communities. Default 1.0. */
  readonly resolution?: number;
  /** Maximum iterations for modularity optimisation. Default 100. */
  readonly maxIterations?: number;
  /** Minimum modularity gain to continue iterating. Default 1e-6. */
  readonly minModularityGain?: number;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface CommunityRow {
  readonly id: string;
  readonly name: string;
  readonly entity_ids: string;
  readonly summary: string;
  readonly created_at: number;
}

interface EntityNameRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToCommunity(row: CommunityRow): KGCommunity {
  let entityIds: readonly string[];
  try {
    const parsed: unknown = JSON.parse(row.entity_ids);
    entityIds = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    entityIds = [];
  }

  return {
    id: row.id,
    name: row.name,
    entityIds,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// CommunityDetector
// ---------------------------------------------------------------------------

export class CommunityDetector {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly resolution: number;
  private readonly maxIterations: number;
  private readonly minModularityGain: number;

  constructor(db: Database, logger: Logger, options?: CommunityDetectorOptions) {
    this.db = db;
    this.logger = logger.child("community-detector");
    this.resolution = options?.resolution ?? 1.0;
    this.maxIterations = options?.maxIterations ?? 100;
    this.minModularityGain = options?.minModularityGain ?? 1e-6;
  }

  /**
   * Detect communities by running a simplified Louvain algorithm on the KG.
   * Persists results to the kg_communities table.
   */
  detectCommunities(): Result<KGCommunity[], EidolonError> {
    try {
      const graph = buildAdjacencyGraph(this.db);

      if (graph.nodes.size === 0) {
        return Ok([]);
      }

      // Phase 1: Local modularity optimisation
      const { assignment, iterations, communityCount } = louvainPhase1(graph, {
        resolution: this.resolution,
        maxIterations: this.maxIterations,
        minModularityGain: this.minModularityGain,
      });

      this.logger.debug("louvainPhase1", `Completed in ${iterations} iterations`, {
        communities: communityCount,
      });

      // Collect communities: communityId -> set of entity IDs
      const communityMap = new Map<string, Set<string>>();
      for (const [nodeId, communityId] of assignment) {
        let members = communityMap.get(communityId);
        if (!members) {
          members = new Set<string>();
          communityMap.set(communityId, members);
        }
        members.add(nodeId);
      }

      // Filter out singleton communities
      const significantCommunities = [...communityMap.entries()].filter(([, members]) => members.size > 1);

      // Persist to database
      const communities = this.persistCommunities(significantCommunities);

      this.logger.info("detectCommunities", `Detected ${communities.length} communities`, {
        totalNodes: graph.nodes.size,
        totalWeight: graph.totalWeight,
      });

      return Ok(communities);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Community detection failed", cause));
    }
  }

  /** Get a community by ID. */
  getCommunity(id: string): Result<KGCommunity | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM kg_communities WHERE id = ?").get(id) as CommunityRow | null;
      return Ok(row ? rowToCommunity(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get community ${id}`, cause));
    }
  }

  /** Find communities containing any of the given entity IDs. */
  findCommunitiesForEntities(entityIds: readonly string[]): Result<KGCommunity[], EidolonError> {
    if (entityIds.length === 0) return Ok([]);
    try {
      const rows = this.db.query("SELECT * FROM kg_communities ORDER BY created_at DESC").all() as CommunityRow[];
      const entityIdSet = new Set(entityIds);
      const matches: KGCommunity[] = [];
      for (const row of rows) {
        const community = rowToCommunity(row);
        const hasOverlap = community.entityIds.some((id) => entityIdSet.has(id));
        if (hasOverlap) {
          matches.push(community);
        }
      }
      return Ok(matches);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to find communities for entities", cause));
    }
  }

  /** Get all communities. */
  getCommunities(): Result<KGCommunity[], EidolonError> {
    try {
      const rows = this.db.query("SELECT * FROM kg_communities ORDER BY created_at DESC").all() as CommunityRow[];
      return Ok(rows.map(rowToCommunity));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get communities", cause));
    }
  }

  /** Generate a text summary of a community's entities and their relationships. */
  summarizeCommunity(communityId: string): Result<string, EidolonError> {
    try {
      const communityResult = this.getCommunity(communityId);
      if (!communityResult.ok) return communityResult;

      const community = communityResult.value;
      if (!community) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Community ${communityId} not found`));
      }

      if (community.entityIds.length === 0) {
        return Ok("Empty community with no entities.");
      }

      // Fetch entity details
      const placeholders = community.entityIds.map(() => "?").join(", ");
      const entities = this.db
        .query(`SELECT id, name, type FROM kg_entities WHERE id IN (${placeholders})`)
        .all(...community.entityIds) as EntityNameRow[];

      if (entities.length === 0) {
        return Ok("Community references entities that no longer exist.");
      }

      // Fetch internal relations (both endpoints within this community)
      const allRelations = this.db
        .query(
          `SELECT r.type AS predicate, s.name AS source_name, t.name AS target_name
           FROM kg_relations r
           JOIN kg_entities s ON s.id = r.source_id
           JOIN kg_entities t ON t.id = r.target_id
           WHERE r.source_id IN (${placeholders}) AND r.target_id IN (${placeholders})`,
        )
        .all(...community.entityIds, ...community.entityIds) as Array<{
        predicate: string;
        source_name: string;
        target_name: string;
      }>;

      // Build summary text
      const entityDescriptions = entities.map((e) => `${e.name} (${e.type})`);
      const lines: string[] = [
        `Community "${community.name}" contains ${entities.length} entities: ${entityDescriptions.join(", ")}.`,
      ];

      if (allRelations.length > 0) {
        lines.push(`Internal relationships (${allRelations.length}):`);
        for (const rel of allRelations) {
          lines.push(`  - ${rel.source_name} ${rel.predicate} ${rel.target_name}`);
        }
      } else {
        lines.push("No internal relationships between community members.");
      }

      const summary = lines.join("\n");

      // Update summary in the database
      this.db.query("UPDATE kg_communities SET summary = ? WHERE id = ?").run(summary, communityId);

      return Ok(summary);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to summarize community ${communityId}`, cause));
    }
  }

  /** Update the summary text of a community. */
  updateSummary(communityId: string, summary: string): Result<void, EidolonError> {
    try {
      this.db.query("UPDATE kg_communities SET summary = ? WHERE id = ?").run(summary, communityId);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update community summary ${communityId}`, cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private: Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist detected communities to the kg_communities table.
   * Clears existing communities first.
   */
  private persistCommunities(communities: ReadonlyArray<readonly [string, Set<string>]>): KGCommunity[] {
    const now = Date.now();
    const results: KGCommunity[] = [];

    const txn = this.db.transaction(() => {
      // Clear existing communities
      this.db.query("DELETE FROM kg_communities").run();

      const insertStmt = this.db.query(
        `INSERT INTO kg_communities (id, name, entity_ids, summary, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );

      let index = 0;
      for (const [, members] of communities) {
        const id = randomUUID();
        const entityIds = [...members];

        // Generate a simple name from the first few entity names
        const entityNames = this.getEntityNames(entityIds.slice(0, 3));
        const name =
          entityNames.length > 0
            ? `Community: ${entityNames.join(", ")}${entityIds.length > 3 ? "..." : ""}`
            : `Community ${index + 1}`;

        const entityIdsJson = JSON.stringify(entityIds);
        const summary = `Community of ${entityIds.length} related entities.`;

        insertStmt.run(id, name, entityIdsJson, summary, now);

        results.push({
          id,
          name,
          entityIds,
          summary,
          createdAt: now,
        });

        index++;
      }
    });

    txn();
    return results;
  }

  /** Look up entity names by IDs. */
  private getEntityNames(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.query(`SELECT name FROM kg_entities WHERE id IN (${placeholders})`).all(...ids) as Array<{
      name: string;
    }>;

    return rows.map((r) => r.name);
  }
}
