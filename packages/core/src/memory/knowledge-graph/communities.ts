/**
 * CommunityDetector -- Louvain-style community detection on the Knowledge Graph.
 *
 * Builds an undirected adjacency graph from kg_relations, then iteratively
 * moves nodes between communities to maximize modularity. Detected communities
 * are persisted to the kg_communities table.
 *
 * All public methods return Result<T, EidolonError>.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, KGCommunity, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";

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

/** Internal adjacency representation. */
interface AdjacencyGraph {
  /** Set of all node IDs. */
  readonly nodes: ReadonlySet<string>;
  /** Adjacency list: nodeId -> Map<neighbourId, edge weight>. */
  readonly adjacency: ReadonlyMap<string, Map<string, number>>;
  /** Total sum of all edge weights (each undirected edge counted once). */
  readonly totalWeight: number;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface RelationEdgeRow {
  readonly source_id: string;
  readonly target_id: string;
  readonly confidence: number;
}

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

/**
 * Build an undirected adjacency graph from the kg_relations table.
 * Edge weights are the confidence values; parallel edges are summed.
 * Self-loops are ignored.
 */
function buildAdjacencyGraph(db: Database): AdjacencyGraph {
  const rows = db.query("SELECT source_id, target_id, confidence FROM kg_relations").all() as RelationEdgeRow[];

  const adjacency = new Map<string, Map<string, number>>();
  const nodes = new Set<string>();
  let totalWeight = 0;

  const ensureNode = (id: string): Map<string, number> => {
    nodes.add(id);
    let neighbours = adjacency.get(id);
    if (!neighbours) {
      neighbours = new Map<string, number>();
      adjacency.set(id, neighbours);
    }
    return neighbours;
  };

  for (const row of rows) {
    if (row.source_id === row.target_id) continue; // skip self-loops
    const weight = row.confidence;

    const srcNeighbours = ensureNode(row.source_id);
    const tgtNeighbours = ensureNode(row.target_id);

    // Undirected: add weight in both directions
    srcNeighbours.set(row.target_id, (srcNeighbours.get(row.target_id) ?? 0) + weight);
    tgtNeighbours.set(row.source_id, (tgtNeighbours.get(row.source_id) ?? 0) + weight);
    totalWeight += weight;
  }

  return { nodes, adjacency, totalWeight };
}

/**
 * Compute the weighted degree of a node (sum of all incident edge weights).
 */
function weightedDegree(adjacency: ReadonlyMap<string, Map<string, number>>, nodeId: string): number {
  const neighbours = adjacency.get(nodeId);
  if (!neighbours) return 0;
  let sum = 0;
  for (const w of neighbours.values()) {
    sum += w;
  }
  return sum;
}

/**
 * Compute the modularity gain from moving node `nodeId` into community `targetCommunity`.
 *
 * deltaQ = [sum_in + 2*k_i_in] / (2*m) - [(sum_tot + k_i) / (2*m)]^2
 *        - [sum_in/(2*m) - (sum_tot/(2*m))^2 - (k_i/(2*m))^2]
 *
 * Simplified to:
 *   deltaQ = k_i_in / m - resolution * k_i * sum_tot / (2 * m^2)
 *
 * where:
 *   k_i_in  = sum of weights from node i to nodes in target community
 *   k_i     = weighted degree of node i
 *   sum_tot = sum of weighted degrees of nodes in target community
 *   m       = total weight of graph
 */
function modularityGain(
  adjacency: ReadonlyMap<string, Map<string, number>>,
  nodeId: string,
  targetMembers: ReadonlySet<string>,
  communityDegreeSum: number,
  totalWeight: number,
  resolution: number,
): number {
  if (totalWeight === 0) return 0;

  const neighbours = adjacency.get(nodeId);
  let kIn = 0;
  if (neighbours) {
    for (const [nId, w] of neighbours) {
      if (targetMembers.has(nId)) {
        kIn += w;
      }
    }
  }

  const ki = weightedDegree(adjacency, nodeId);
  const m = totalWeight;

  return kIn / m - (resolution * ki * communityDegreeSum) / (2 * m * m);
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
      const assignment = this.louvainPhase1(graph);

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

      // Filter out singleton communities (a single isolated node is not interesting)
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

  /**
   * Generate a text summary of a community's entities and their relationships.
   */
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

      // Filter to only internal relations (both source and target in the community)
      // The SQL already handles this via the WHERE clause

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

  /**
   * Update the summary text of a community.
   * Used by the NREM phase to store LLM-generated summaries.
   */
  updateSummary(communityId: string, summary: string): Result<void, EidolonError> {
    try {
      this.db.query("UPDATE kg_communities SET summary = ? WHERE id = ?").run(summary, communityId);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update community summary ${communityId}`, cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private: Louvain Algorithm
  // -------------------------------------------------------------------------

  /**
   * Louvain Phase 1: Iteratively move each node to the neighbouring community
   * that maximises modularity gain. Returns a map from nodeId -> communityId.
   */
  private louvainPhase1(graph: AdjacencyGraph): Map<string, string> {
    const { nodes, adjacency, totalWeight } = graph;

    // Initialise: each node is its own community
    const assignment = new Map<string, string>();
    for (const nodeId of nodes) {
      assignment.set(nodeId, nodeId);
    }

    // Track community membership: communityId -> Set of nodeIds
    const communityMembers = new Map<string, Set<string>>();
    for (const nodeId of nodes) {
      communityMembers.set(nodeId, new Set([nodeId]));
    }

    // Track sum of weighted degrees per community
    const communityDegreeSum = new Map<string, number>();
    for (const nodeId of nodes) {
      communityDegreeSum.set(nodeId, weightedDegree(adjacency, nodeId));
    }

    let improved = true;
    let iteration = 0;

    while (improved && iteration < this.maxIterations) {
      improved = false;
      iteration++;

      for (const nodeId of nodes) {
        const currentCommunity = assignment.get(nodeId);
        if (currentCommunity === undefined) continue;

        const ki = weightedDegree(adjacency, nodeId);
        const neighbours = adjacency.get(nodeId);
        if (!neighbours) continue;

        // Collect neighbouring communities
        const neighbourCommunities = new Set<string>();
        for (const [nId] of neighbours) {
          const nComm = assignment.get(nId);
          if (nComm !== undefined && nComm !== currentCommunity) {
            neighbourCommunities.add(nComm);
          }
        }

        if (neighbourCommunities.size === 0) continue;

        // Compute the loss of removing nodeId from its current community
        const currentMembers = communityMembers.get(currentCommunity);
        if (!currentMembers) continue;

        // Temporarily remove node from current community for gain calculation
        const currentDegSum = (communityDegreeSum.get(currentCommunity) ?? 0) - ki;

        // Create a temp set without the current node for computing k_i_in for removal cost
        const currentMembersWithout = new Set(currentMembers);
        currentMembersWithout.delete(nodeId);

        const removeLoss = modularityGain(
          adjacency,
          nodeId,
          currentMembersWithout,
          currentDegSum,
          totalWeight,
          this.resolution,
        );

        // Find the best community to move to
        let bestCommunity = currentCommunity;
        let bestGain = 0;

        for (const targetCommunity of neighbourCommunities) {
          const targetMembers = communityMembers.get(targetCommunity);
          if (!targetMembers) continue;

          const targetDegSum = communityDegreeSum.get(targetCommunity) ?? 0;

          const gain =
            modularityGain(adjacency, nodeId, targetMembers, targetDegSum, totalWeight, this.resolution) - removeLoss;

          if (gain > bestGain + this.minModularityGain) {
            bestGain = gain;
            bestCommunity = targetCommunity;
          }
        }

        // Move node if beneficial
        if (bestCommunity !== currentCommunity) {
          // Remove from current community
          currentMembers.delete(nodeId);
          communityDegreeSum.set(currentCommunity, (communityDegreeSum.get(currentCommunity) ?? 0) - ki);

          // Clean up empty communities
          if (currentMembers.size === 0) {
            communityMembers.delete(currentCommunity);
            communityDegreeSum.delete(currentCommunity);
          }

          // Add to best community
          const bestMembers = communityMembers.get(bestCommunity);
          if (bestMembers) {
            bestMembers.add(nodeId);
          }
          communityDegreeSum.set(bestCommunity, (communityDegreeSum.get(bestCommunity) ?? 0) + ki);

          assignment.set(nodeId, bestCommunity);
          improved = true;
        }
      }
    }

    this.logger.debug("louvainPhase1", `Completed in ${iteration} iterations`, {
      communities: communityMembers.size,
    });

    return assignment;
  }

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
