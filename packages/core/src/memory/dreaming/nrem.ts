/**
 * NREM Phase (Schema Abstraction) -- uses LLM (stubbed for now).
 *
 * 1. Cluster memories by type.
 * 2. For clusters with 3+ memories, abstract general rules (stubbed).
 * 3. Promote consolidated short-term memories to long_term.
 */

import type { EidolonError, Memory, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.js";
import type { MemoryStore } from "../store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NremResult {
  readonly memoriesPromoted: number;
  readonly schemasCreated: number;
}

/**
 * LLM function for abstracting rules from a cluster of similar memories.
 * Returns a general rule/schema string, or null if no abstraction is possible.
 */
export type AbstractRuleFn = (memories: readonly string[]) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_PROMOTION_CONFIDENCE = 0.7;
const PROMOTION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// NremPhase
// ---------------------------------------------------------------------------

export class NremPhase {
  private readonly store: MemoryStore;
  private readonly logger: Logger;

  constructor(store: MemoryStore, logger: Logger) {
    this.store = store;
    this.logger = logger.child("nrem");
  }

  /** Run the NREM phase. */
  async run(options?: {
    minClusterSize?: number;
    promotionConfidence?: number;
    abstractFn?: AbstractRuleFn;
  }): Promise<Result<NremResult, EidolonError>> {
    try {
      const minClusterSize = options?.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
      const promotionConfidence = options?.promotionConfidence ?? DEFAULT_PROMOTION_CONFIDENCE;

      // 1. Promote eligible short-term memories to long_term
      const promotionResult = this.promoteMemories(promotionConfidence);
      if (!promotionResult.ok) return promotionResult;
      const memoriesPromoted = promotionResult.value;

      // 2. Cluster long-term memories by type and attempt schema abstraction
      let schemasCreated = 0;
      if (options?.abstractFn) {
        const schemaResult = await this.abstractSchemas(minClusterSize, options.abstractFn);
        if (schemaResult.ok) {
          schemasCreated = schemaResult.value;
        }
      }

      const result: NremResult = {
        memoriesPromoted,
        schemasCreated,
      };

      this.logger.info("run", "NREM phase complete", {
        memoriesPromoted,
        schemasCreated,
      });

      return Ok(result);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "NREM phase failed", cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Promote short-term memories to long_term if they have sufficient confidence
   * and are old enough (> 7 days).
   */
  private promoteMemories(minConfidence: number): Result<number, EidolonError> {
    const listResult = this.store.list({
      layers: ["short_term"],
      minConfidence,
      limit: 500,
      orderBy: "created_at",
      order: "asc",
    });
    if (!listResult.ok) return listResult;

    const cutoff = Date.now() - PROMOTION_AGE_MS;
    const candidates = listResult.value.filter((m) => m.createdAt < cutoff);

    let promoted = 0;
    for (const mem of candidates) {
      const updateResult = this.store.update(mem.id, { layer: "long_term" });
      if (updateResult.ok) {
        promoted++;
        this.logger.debug("promoteMemories", `Promoted memory ${mem.id} to long_term`, {
          confidence: mem.confidence,
          ageMs: Date.now() - mem.createdAt,
        });
      }
    }

    return Ok(promoted);
  }

  /**
   * Abstract schemas from clusters of memories.
   * Groups long-term memories by type, and for clusters above minClusterSize,
   * calls the abstractFn to produce a general rule.
   */
  private async abstractSchemas(
    minClusterSize: number,
    abstractFn: AbstractRuleFn,
  ): Promise<Result<number, EidolonError>> {
    const listResult = this.store.list({
      layers: ["long_term"],
      limit: 500,
      orderBy: "created_at",
      order: "desc",
    });
    if (!listResult.ok) return listResult;

    const byType = new Map<string, Memory[]>();
    for (const mem of listResult.value) {
      const list = byType.get(mem.type) ?? [];
      list.push(mem);
      byType.set(mem.type, list);
    }

    let schemasCreated = 0;

    for (const [type, mems] of byType) {
      if (mems.length < minClusterSize) continue;

      const contents = mems.map((m) => m.content);
      try {
        const rule = await abstractFn(contents);
        if (rule) {
          // Create a schema memory from the abstracted rule
          const createResult = this.store.create({
            type: "schema",
            layer: "long_term",
            content: rule,
            confidence: 0.8,
            source: "dreaming:nrem",
            tags: [`schema:${type}`],
          });

          if (createResult.ok) {
            schemasCreated++;
            this.logger.debug("abstractSchemas", `Created schema for type ${type}`, {
              sourceMemories: mems.length,
            });
          }
        }
      } catch {
        this.logger.warn("abstractSchemas", `Schema abstraction failed for type ${type}`);
      }
    }

    return Ok(schemasCreated);
  }
}
