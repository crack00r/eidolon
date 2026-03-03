/**
 * Memory types for the 5-layer memory system and Knowledge Graph.
 */

export type MemoryType = "fact" | "preference" | "decision" | "episode" | "skill" | "relationship" | "schema";

export type MemoryLayer = "working" | "short_term" | "long_term" | "episodic" | "procedural";

export interface Memory {
  readonly id: string;
  readonly type: MemoryType;
  readonly layer: MemoryLayer;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly tags: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly accessedAt: number;
  readonly accessCount: number;
  readonly embedding?: Float32Array;
  readonly metadata?: Record<string, unknown>;
  /** Flag for PII-containing memories that may need special handling (GDPR, encryption). */
  readonly sensitive?: boolean;
}

export interface MemoryEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relation: string;
  readonly weight: number;
  readonly createdAt: number;
}

export interface MemorySearchQuery {
  readonly text: string;
  readonly limit?: number;
  readonly types?: readonly MemoryType[];
  readonly layers?: readonly MemoryLayer[];
  readonly minConfidence?: number;
  readonly tags?: readonly string[];
  readonly includeGraph?: boolean;
}

export interface MemorySearchResult {
  readonly memory: Memory;
  readonly score: number;
  readonly bm25Score?: number;
  readonly vectorScore?: number;
  readonly graphScore?: number;
  readonly matchReason: string;
}

export interface KGEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly attributes: Record<string, unknown>;
  readonly embedding?: Float32Array;
  readonly createdAt: number;
}

export interface KGRelation {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
  readonly confidence: number;
  readonly source: string;
  readonly createdAt: number;
}

export interface KGCommunity {
  readonly id: string;
  readonly name: string;
  readonly entityIds: readonly string[];
  readonly summary: string;
  readonly createdAt: number;
}

export interface DreamingResult {
  readonly phase: "housekeeping" | "rem" | "nrem";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly memoriesProcessed: number;
  readonly memoriesCreated: number;
  readonly memoriesRemoved: number;
  readonly edgesCreated: number;
  readonly tokensUsed: number;
}

// ---------------------------------------------------------------------------
// Memory Consolidation (Mem0-style ADD/UPDATE/DELETE/NOOP)
// ---------------------------------------------------------------------------

/** Action to take when consolidating a newly extracted memory against the existing store. */
export type MemoryConsolidationAction = "ADD" | "UPDATE" | "DELETE" | "NOOP";

/** The decision made by the consolidator for a single extracted memory. */
export interface ConsolidationDecision {
  readonly action: MemoryConsolidationAction;
  /** For UPDATE/DELETE: the ID of the existing memory to modify/remove. */
  readonly memoryId?: string;
  /** For ADD/UPDATE: the memory content to write. */
  readonly content?: string;
  /** For ADD/UPDATE: the confidence score. */
  readonly confidence?: number;
  /** Human-readable reason for this decision. */
  readonly reason: string;
}

/** Result summary from a consolidation batch. */
export interface ConsolidationResult {
  readonly decisions: readonly ConsolidationDecision[];
  readonly added: number;
  readonly updated: number;
  readonly deleted: number;
  readonly noops: number;
}

// ---------------------------------------------------------------------------
// Memory Compression
// ---------------------------------------------------------------------------

/** Strategy for compressing memory clusters. */
export type CompressionStrategy = "none" | "progressive" | "hierarchical";

/** Result of a compression operation. */
export interface CompressionResult {
  /** Number of source memories that were compressed. */
  readonly memoriesCompressed: number;
  /** Number of new summary memories created. */
  readonly summariesCreated: number;
  /** IDs of memories that were removed after compression. */
  readonly removedMemoryIds: readonly string[];
}
