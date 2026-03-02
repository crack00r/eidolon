/**
 * Housekeeping Phase (Light Sleep) -- no LLM needed.
 *
 * 1. Duplicate detection: Find memories with very similar content
 *    (Jaccard similarity on word sets > 0.95), merge them.
 * 2. Contradiction flagging: Find memories of the same type with
 *    overlapping keywords but low similarity (potential contradictions).
 * 3. Expiry pruning: Remove short_term memories past their TTL.
 * 4. Edge weight decay: Decay all edge weights by a factor.
 */

import type { EidolonError, Memory, MemoryType, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { GraphMemory } from "../graph.ts";
import type { MemoryStore } from "../store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HousekeepingResult {
  readonly duplicatesMerged: number;
  readonly expired: number;
  readonly edgesDecayed: number;
  readonly contradictionsFound: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const DEFAULT_DECAY_FACTOR = 0.98;
const DEFAULT_SIMILARITY_THRESHOLD = 0.95;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Jaccard similarity on word sets. Cheap string-level comparison. */
export function stringSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1.0;

  const setA = new Set(na.split(/\s+/));
  const setB = new Set(nb.split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ---------------------------------------------------------------------------
// HousekeepingPhase
// ---------------------------------------------------------------------------

export class HousekeepingPhase {
  private readonly store: MemoryStore;
  private readonly graph: GraphMemory;
  private readonly logger: Logger;

  constructor(store: MemoryStore, graph: GraphMemory, logger: Logger) {
    this.store = store;
    this.graph = graph;
    this.logger = logger.child("housekeeping");
  }

  /** Run the full housekeeping phase. */
  async run(options?: { maxAgeMs?: number; decayFactor?: number }): Promise<Result<HousekeepingResult, EidolonError>> {
    try {
      const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
      const decayFactor = options?.decayFactor ?? DEFAULT_DECAY_FACTOR;

      // 1. Find and merge duplicates
      const dupsResult = this.findDuplicates();
      if (!dupsResult.ok) return dupsResult;

      let duplicatesMerged = 0;
      for (const dup of dupsResult.value) {
        const mergeResult = this.mergeDuplicates(dup.id1, dup.id2);
        if (mergeResult.ok) {
          duplicatesMerged++;
        }
      }

      // 2. Find contradictions (flag only, no resolution in housekeeping)
      const contradictionsResult = this.findContradictions();
      const contradictionsFound = contradictionsResult.ok ? contradictionsResult.value.length : 0;

      // 3. Prune expired short-term memories
      const cutoff = Date.now() - maxAgeMs;
      const pruneResult = this.store.pruneExpired(cutoff);
      const expired = pruneResult.ok ? pruneResult.value : 0;

      // 4. Decay edge weights
      const decayResult = this.graph.decayWeights(decayFactor);
      const edgesDecayed = decayResult.ok ? decayResult.value : 0;

      const result: HousekeepingResult = {
        duplicatesMerged,
        expired,
        edgesDecayed,
        contradictionsFound,
      };

      this.logger.info("run", "Housekeeping complete", {
        duplicatesMerged,
        expired,
        edgesDecayed,
        contradictionsFound,
      });

      return Ok(result);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Housekeeping phase failed", cause));
    }
  }

  /**
   * Find near-duplicate memories (string similarity > threshold).
   * Compares pairwise within each memory type. O(n²) per type.
   */
  findDuplicates(
    threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  ): Result<Array<{ id1: string; id2: string; similarity: number }>, EidolonError> {
    const allResult = this.store.list({ limit: 1000 });
    if (!allResult.ok) return allResult;

    const memories = allResult.value;
    const byType = new Map<MemoryType, Memory[]>();

    for (const mem of memories) {
      const list = byType.get(mem.type) ?? [];
      list.push(mem);
      byType.set(mem.type, list);
    }

    const duplicates: Array<{ id1: string; id2: string; similarity: number }> = [];

    for (const [, mems] of byType) {
      for (let i = 0; i < mems.length; i++) {
        for (let j = i + 1; j < mems.length; j++) {
          const a = mems[i] as Memory;
          const b = mems[j] as Memory;
          const sim = stringSimilarity(a.content, b.content);
          if (sim >= threshold) {
            duplicates.push({ id1: a.id, id2: b.id, similarity: sim });
          }
        }
      }
    }

    this.logger.debug("findDuplicates", `Found ${duplicates.length} duplicate pairs`, { threshold });
    return Ok(duplicates);
  }

  /**
   * Merge two memories: keep the newer one, boost its confidence, delete the older.
   * The "newer" is determined by updatedAt timestamp.
   */
  mergeDuplicates(keepId: string, removeId: string): Result<void, EidolonError> {
    // Get both memories to determine which is newer
    const keepResult = this.store.get(keepId);
    if (!keepResult.ok) return keepResult;
    const removeResult = this.store.get(removeId);
    if (!removeResult.ok) return removeResult;

    if (!keepResult.value || !removeResult.value) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "One or both memories not found for merge"));
    }

    // Determine which is newer
    let newer = keepResult.value;
    let older = removeResult.value;
    if (older.updatedAt > newer.updatedAt) {
      [newer, older] = [older, newer];
    }

    // Boost confidence of newer (capped at 1.0)
    const boostedConfidence = Math.min(newer.confidence + 0.05, 1.0);
    const updateResult = this.store.update(newer.id, { confidence: boostedConfidence });
    if (!updateResult.ok) return updateResult;

    // Delete the older memory and its edges
    this.graph.deleteAllForMemory(older.id);
    const deleteResult = this.store.delete(older.id);
    if (!deleteResult.ok) return deleteResult;

    this.logger.debug("mergeDuplicates", `Merged ${older.id} into ${newer.id}`, {
      boostedConfidence,
    });

    return Ok(undefined);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Find potential contradictions: same type, overlapping keywords,
   * but low overall similarity (between 0.2 and 0.6).
   */
  private findContradictions(): Result<Array<{ id1: string; id2: string; similarity: number }>, EidolonError> {
    const allResult = this.store.list({ limit: 1000 });
    if (!allResult.ok) return allResult;

    const memories = allResult.value;
    const byType = new Map<MemoryType, Memory[]>();

    for (const mem of memories) {
      const list = byType.get(mem.type) ?? [];
      list.push(mem);
      byType.set(mem.type, list);
    }

    const contradictions: Array<{ id1: string; id2: string; similarity: number }> = [];

    for (const [, mems] of byType) {
      for (let i = 0; i < mems.length; i++) {
        for (let j = i + 1; j < mems.length; j++) {
          const a = mems[i] as Memory;
          const b = mems[j] as Memory;
          const sim = stringSimilarity(a.content, b.content);
          // Contradictions: some overlap (0.2-0.6) suggests same topic, different conclusion
          if (sim >= 0.2 && sim <= 0.6) {
            contradictions.push({ id1: a.id, id2: b.id, similarity: sim });
          }
        }
      }
    }

    return Ok(contradictions);
  }
}
