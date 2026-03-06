/**
 * MemoryConsolidator -- Mem0-style ADD/UPDATE/DELETE/NOOP classification.
 *
 * Before writing a newly extracted memory to the store, the consolidator
 * checks whether a similar memory already exists. Based on cosine similarity
 * thresholds (configurable via memory.consolidation config), it decides:
 *
 *   - NOOP  (sim > duplicateThreshold):  Exact/near-duplicate. Skip.
 *   - UPDATE (sim > updateThreshold):    Similar enough to merge.
 *   - DELETE + ADD (contradiction):      Old memory contradicted. Replace.
 *   - ADD   (no match):                  New information. Store.
 *
 * This prevents memory bloat, resolves contradictions at extraction time
 * (not just during dreaming), and measurably improves memory quality.
 */

import type {
  ConsolidationDecision,
  ConsolidationResult,
  EidolonError,
  MemoryConsolidationAction,
  Result,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EmbeddingModel } from "./embeddings.ts";
import type { ExtractedMemory } from "./extractor.ts";
import type { CreateMemoryInput, MemoryStore, UpdateMemoryInput } from "./store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the consolidator, typically derived from memory.consolidation config. */
export interface ConsolidationConfig {
  /** Whether consolidation is enabled. When false, all extractions are ADD. */
  readonly enabled: boolean;
  /** Cosine similarity above which a memory is a duplicate (NOOP). Default 0.95. */
  readonly duplicateThreshold: number;
  /** Cosine similarity above which a memory should be merged (UPDATE). Default 0.85. */
  readonly updateThreshold: number;
  /** Maximum candidates to compare against per extraction. Default 10. */
  readonly maxCandidates: number;
}

/** Optional LLM-based contradiction detector for ambiguous cases. */
export type ContradictionDetectorFn = (existing: string, incoming: string) => Promise<boolean>;

export interface ConsolidatorOptions {
  readonly config: ConsolidationConfig;
  /** Optional LLM-based contradiction detector for cases where similarity is moderate. */
  readonly contradictionDetectorFn?: ContradictionDetectorFn;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: ConsolidationConfig = {
  enabled: true,
  duplicateThreshold: 0.95,
  updateThreshold: 0.85,
  maxCandidates: 10,
};

// ---------------------------------------------------------------------------
// MemoryConsolidator
// ---------------------------------------------------------------------------

export class MemoryConsolidator {
  private readonly store: MemoryStore;
  private readonly embeddingModel: EmbeddingModel;
  private readonly logger: Logger;
  private readonly config: ConsolidationConfig;
  private readonly contradictionDetectorFn?: ContradictionDetectorFn;

  constructor(
    store: MemoryStore,
    embeddingModel: EmbeddingModel,
    logger: Logger,
    options?: Partial<ConsolidatorOptions>,
  ) {
    this.store = store;
    this.embeddingModel = embeddingModel;
    this.logger = logger.child("consolidator");
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.contradictionDetectorFn = options?.contradictionDetectorFn;
  }

  /**
   * Classify a single extracted memory against existing memories.
   * Returns a ConsolidationDecision indicating the action to take.
   */
  async classify(extracted: ExtractedMemory): Promise<Result<ConsolidationDecision, EidolonError>> {
    if (!this.config.enabled) {
      return Ok({
        action: "ADD" as MemoryConsolidationAction,
        content: extracted.content,
        confidence: extracted.confidence,
        reason: "Consolidation disabled -- always ADD",
      });
    }

    // Generate embedding for the incoming memory
    if (!this.embeddingModel.isInitialized) {
      const initResult = await this.embeddingModel.initialize();
      if (!initResult.ok) {
        // If embedding model is not available, fall back to ADD
        this.logger.warn("classify", "Embedding model unavailable, falling back to ADD");
        return Ok({
          action: "ADD" as MemoryConsolidationAction,
          content: extracted.content,
          confidence: extracted.confidence,
          reason: "Embedding model unavailable -- fallback to ADD",
        });
      }
    }

    const embedResult = await this.embeddingModel.embed(extracted.content, "passage");
    if (!embedResult.ok) {
      this.logger.warn("classify", "Failed to embed extracted memory, falling back to ADD");
      return Ok({
        action: "ADD" as MemoryConsolidationAction,
        content: extracted.content,
        confidence: extracted.confidence,
        reason: `Embedding failed: ${embedResult.error.message} -- fallback to ADD`,
      });
    }

    const embedding = embedResult.value;

    // Find similar memories from the store
    const similarResult = this.store.findSimilar(embedding, this.config.maxCandidates, this.config.updateThreshold);

    if (!similarResult.ok) {
      this.logger.warn("classify", "findSimilar failed, falling back to ADD");
      return Ok({
        action: "ADD" as MemoryConsolidationAction,
        content: extracted.content,
        confidence: extracted.confidence,
        reason: `Similarity search failed: ${similarResult.error.message} -- fallback to ADD`,
      });
    }

    const candidates = similarResult.value;

    // No similar memories found -- ADD
    if (candidates.length === 0) {
      return Ok({
        action: "ADD" as MemoryConsolidationAction,
        content: extracted.content,
        confidence: extracted.confidence,
        reason: "No similar memories found",
      });
    }

    // Check the top candidate
    const top = candidates[0];
    if (!top) {
      return Ok({
        action: "ADD" as MemoryConsolidationAction,
        content: extracted.content,
        confidence: extracted.confidence,
        reason: "No similar memories found",
      });
    }

    // NOOP: near-duplicate (similarity > duplicateThreshold)
    if (top.similarity >= this.config.duplicateThreshold) {
      this.logger.debug("classify", `NOOP: duplicate detected (sim=${top.similarity.toFixed(3)})`, {
        existingId: top.memory.id,
      });
      return Ok({
        action: "NOOP" as MemoryConsolidationAction,
        memoryId: top.memory.id,
        reason: `Duplicate detected (similarity ${top.similarity.toFixed(3)} >= ${this.config.duplicateThreshold})`,
      });
    }

    // UPDATE or contradiction: similarity > updateThreshold but < duplicateThreshold
    // Check for contradiction
    const isContradiction = await this.detectContradiction(top.memory.content, extracted.content);

    if (isContradiction) {
      // DELETE old + ADD new (contradiction resolution)
      this.logger.debug("classify", `DELETE+ADD: contradiction detected (sim=${top.similarity.toFixed(3)})`, {
        existingId: top.memory.id,
      });
      return Ok({
        action: "DELETE" as MemoryConsolidationAction,
        memoryId: top.memory.id,
        content: extracted.content,
        confidence: extracted.confidence,
        reason: `Contradiction detected with memory ${top.memory.id} (similarity ${top.similarity.toFixed(3)})`,
      });
    }

    // UPDATE: merge the new content into the existing memory
    const mergedContent = this.mergeContent(top.memory.content, extracted.content);
    const mergedConfidence = Math.max(top.memory.confidence, extracted.confidence);

    this.logger.debug("classify", `UPDATE: merging with existing (sim=${top.similarity.toFixed(3)})`, {
      existingId: top.memory.id,
    });

    return Ok({
      action: "UPDATE" as MemoryConsolidationAction,
      memoryId: top.memory.id,
      content: mergedContent,
      confidence: mergedConfidence,
      reason: `Similar memory found (similarity ${top.similarity.toFixed(3)} >= ${this.config.updateThreshold}), merging`,
    });
  }

  /**
   * Process a batch of extracted memories through consolidation.
   * Returns the consolidation result with action counts and all decisions.
   */
  async consolidate(
    extracted: readonly ExtractedMemory[],
    sessionId?: string,
  ): Promise<Result<ConsolidationResult, EidolonError>> {
    const decisions: ConsolidationDecision[] = [];
    let added = 0;
    let updated = 0;
    let deleted = 0;
    let noops = 0;

    for (const mem of extracted) {
      const decisionResult = await this.classify(mem);
      if (!decisionResult.ok) {
        return Err(decisionResult.error);
      }

      const decision = decisionResult.value;
      decisions.push(decision);

      // Apply the decision to the store
      const applyResult = this.applyDecision(decision, mem, sessionId);
      if (!applyResult.ok) {
        this.logger.warn("consolidate", `Failed to apply decision: ${applyResult.error.message}`, {
          action: decision.action,
          memoryId: decision.memoryId,
        });
        // Continue processing remaining memories
        continue;
      }

      switch (decision.action) {
        case "ADD":
          added++;
          break;
        case "UPDATE":
          updated++;
          break;
        case "DELETE":
          deleted++;
          added++; // DELETE also creates a new replacement memory
          break;
        case "NOOP":
          noops++;
          break;
      }
    }

    this.logger.info("consolidate", `Consolidation complete`, {
      total: extracted.length,
      added,
      updated,
      deleted,
      noops,
    });

    return Ok({ decisions, added, updated, deleted, noops });
  }

  /**
   * Apply a single consolidation decision to the store.
   */
  private applyDecision(
    decision: ConsolidationDecision,
    extracted: ExtractedMemory,
    sessionId?: string,
  ): Result<void, EidolonError> {
    switch (decision.action) {
      case "ADD": {
        const input: CreateMemoryInput = {
          type: extracted.type,
          layer: "short_term",
          content: decision.content ?? extracted.content,
          confidence: decision.confidence ?? extracted.confidence,
          source: `extraction:${extracted.source}`,
          tags: [...extracted.tags],
          metadata: sessionId ? { sessionId } : undefined,
          sensitive: extracted.sensitive,
        };
        const createResult = this.store.create(input);
        if (!createResult.ok) return Err(createResult.error);
        return Ok(undefined);
      }

      case "UPDATE": {
        if (!decision.memoryId) {
          return Err(createError(ErrorCode.DB_QUERY_FAILED, "UPDATE decision missing memoryId"));
        }
        const updateInput: UpdateMemoryInput = {
          content: decision.content,
          confidence: decision.confidence,
        };
        const updateResult = this.store.update(decision.memoryId, updateInput);
        if (!updateResult.ok) return Err(updateResult.error);
        return Ok(undefined);
      }

      case "DELETE": {
        if (!decision.memoryId) {
          return Err(createError(ErrorCode.DB_QUERY_FAILED, "DELETE decision missing memoryId"));
        }
        // Delete the old memory
        const deleteResult = this.store.delete(decision.memoryId);
        if (!deleteResult.ok) return Err(deleteResult.error);

        // Add the replacement memory
        const replaceInput: CreateMemoryInput = {
          type: extracted.type,
          layer: "short_term",
          content: decision.content ?? extracted.content,
          confidence: decision.confidence ?? extracted.confidence,
          source: `extraction:${extracted.source}`,
          tags: [...extracted.tags],
          metadata: sessionId ? { sessionId, replacedMemoryId: decision.memoryId } : undefined,
          sensitive: extracted.sensitive,
        };
        const createResult = this.store.create(replaceInput);
        if (!createResult.ok) return Err(createResult.error);
        return Ok(undefined);
      }

      case "NOOP": {
        // Nothing to do
        return Ok(undefined);
      }

      default: {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Unknown consolidation action: ${decision.action}`));
      }
    }
  }

  /**
   * Detect contradiction between two memory contents.
   * Uses injected LLM function if available, otherwise falls back to
   * simple heuristic negation detection.
   */
  private async detectContradiction(existing: string, incoming: string): Promise<boolean> {
    // Try LLM-based detection if available
    if (this.contradictionDetectorFn) {
      try {
        return await this.contradictionDetectorFn(existing, incoming);
      } catch {
        this.logger.warn("detectContradiction", "LLM contradiction detection failed, using heuristic");
      }
    }

    // Heuristic: check for explicit negation/contradiction patterns
    return MemoryConsolidator.heuristicContradiction(existing, incoming);
  }

  /**
   * Heuristic contradiction detection based on negation patterns.
   * Returns true if the two texts appear to contradict each other.
   */
  static heuristicContradiction(a: string, b: string): boolean {
    const normA = a.toLowerCase().trim();
    const normB = b.toLowerCase().trim();

    // Check for explicit negation patterns
    const negationPairs: ReadonlyArray<[RegExp, RegExp]> = [
      [/\bprefers?\b.*\b(\w+)\b/, /\b(?:doesn't|does not|nicht)\s+prefer\b.*\b(\w+)\b/],
      [/\blikes?\b.*\b(\w+)\b/, /\b(?:doesn't|does not|nicht)\s+like\b.*\b(\w+)\b/],
      [/\buses?\b.*\b(\w+)\b/, /\b(?:doesn't|does not|nicht)\s+use\b.*\b(\w+)\b/],
      [/\bis\b.*\b(\w+)\b/, /\bis\s+not\b.*\b(\w+)\b/],
      [/\bwants?\b.*\b(\w+)\b/, /\b(?:doesn't|does not|nicht)\s+want\b.*\b(\w+)\b/],
    ];

    for (const [positive, negative] of negationPairs) {
      if ((positive.test(normA) && negative.test(normB)) || (negative.test(normA) && positive.test(normB))) {
        return true;
      }
    }

    // Check for "actually" / "correction" patterns that often indicate contradiction
    const correctionPatterns = [
      /\bactually\b/i,
      /\beigentlich\b/i,
      /\bthat's wrong\b/i,
      /\bdas stimmt nicht\b/i,
      /\bnot\s+\w+\s*,?\s*(?:but|sondern)\b/i,
    ];

    const bHasCorrection = correctionPatterns.some((p) => p.test(normB));
    if (bHasCorrection) {
      // If the incoming text has correction markers and shares significant words
      // with the existing text, it's likely a contradiction
      const wordsA = new Set(normA.split(/\s+/).filter((w) => w.length > 3));
      const wordsB = new Set(normB.split(/\s+/).filter((w) => w.length > 3));
      let overlap = 0;
      for (const w of wordsA) {
        if (wordsB.has(w)) overlap++;
      }
      // If there is meaningful word overlap with a correction marker, likely contradiction
      if (overlap >= 2) return true;
    }

    return false;
  }

  /**
   * Merge two memory contents. Takes the longer/more detailed version
   * or combines them if they contain complementary information.
   */
  private mergeContent(existing: string, incoming: string): string {
    // If one is substantially longer, prefer the longer one
    if (incoming.length > existing.length * 1.5) {
      return incoming;
    }
    if (existing.length > incoming.length * 1.5) {
      return existing;
    }

    // If similar length, prefer the incoming (more recent information)
    return incoming;
  }
}
