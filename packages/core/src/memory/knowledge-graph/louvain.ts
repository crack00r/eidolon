/**
 * Louvain algorithm implementation for community detection.
 *
 * Builds an undirected adjacency graph from kg_relations, then iteratively
 * moves nodes between communities to maximize modularity.
 *
 * Extracted from communities.ts to keep files under 300 lines.
 */

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Internal adjacency representation. */
export interface AdjacencyGraph {
  /** Set of all node IDs. */
  readonly nodes: ReadonlySet<string>;
  /** Adjacency list: nodeId -> Map<neighbourId, edge weight>. */
  readonly adjacency: ReadonlyMap<string, Map<string, number>>;
  /** Total sum of all edge weights (each undirected edge counted once). */
  readonly totalWeight: number;
}

interface RelationEdgeRow {
  readonly source_id: string;
  readonly target_id: string;
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Graph building
// ---------------------------------------------------------------------------

/**
 * Build an undirected adjacency graph from the kg_relations table.
 * Edge weights are the confidence values; parallel edges are summed.
 * Self-loops are ignored.
 */
export function buildAdjacencyGraph(db: Database): AdjacencyGraph {
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

// ---------------------------------------------------------------------------
// Modularity helpers
// ---------------------------------------------------------------------------

/**
 * Compute the weighted degree of a node (sum of all incident edge weights).
 */
export function weightedDegree(adjacency: ReadonlyMap<string, Map<string, number>>, nodeId: string): number {
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
 * Simplified to:
 *   deltaQ = k_i_in / m - resolution * k_i * sum_tot / (2 * m^2)
 *
 * where:
 *   k_i_in  = sum of weights from node i to nodes in target community
 *   k_i     = weighted degree of node i
 *   sum_tot = sum of weighted degrees of nodes in target community
 *   m       = total weight of graph
 */
export function modularityGain(
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
// Louvain Phase 1
// ---------------------------------------------------------------------------

export interface LouvainOptions {
  readonly resolution: number;
  readonly maxIterations: number;
  readonly minModularityGain: number;
}

/**
 * Louvain Phase 1: Iteratively move each node to the neighbouring community
 * that maximises modularity gain. Returns a map from nodeId -> communityId.
 */
export function louvainPhase1(
  graph: AdjacencyGraph,
  options: LouvainOptions,
): { assignment: Map<string, string>; iterations: number; communityCount: number } {
  const { nodes, adjacency, totalWeight } = graph;
  const { resolution, maxIterations, minModularityGain } = options;

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

  while (improved && iteration < maxIterations) {
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

      // Create a temp set without the current node
      const currentMembersWithout = new Set(currentMembers);
      currentMembersWithout.delete(nodeId);

      const removeLoss = modularityGain(
        adjacency,
        nodeId,
        currentMembersWithout,
        currentDegSum,
        totalWeight,
        resolution,
      );

      // Find the best community to move to
      let bestCommunity = currentCommunity;
      let bestGain = 0;

      for (const targetCommunity of neighbourCommunities) {
        const targetMembers = communityMembers.get(targetCommunity);
        if (!targetMembers) continue;

        const targetDegSum = communityDegreeSum.get(targetCommunity) ?? 0;

        const gain =
          modularityGain(adjacency, nodeId, targetMembers, targetDegSum, totalWeight, resolution) - removeLoss;

        if (gain > bestGain + minModularityGain) {
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

  return { assignment, iterations: iteration, communityCount: communityMembers.size };
}
