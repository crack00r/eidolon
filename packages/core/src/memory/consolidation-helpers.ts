/**
 * MemoryConsolidator helpers -- heuristic contradiction detection and decision application.
 *
 * Extracted from consolidation.ts to keep file sizes manageable.
 */

import type { ConsolidationDecision, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { ExtractedMemory } from "./extractor.ts";
import type { CreateMemoryInput, MemoryStore, UpdateMemoryInput } from "./store.ts";

// ---------------------------------------------------------------------------
// Decision application
// ---------------------------------------------------------------------------

/**
 * Apply a single consolidation decision to the store.
 */
export function applyDecision(
  store: MemoryStore,
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
      const createResult = store.create(input);
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
      const updateResult = store.update(decision.memoryId, updateInput);
      if (!updateResult.ok) return Err(updateResult.error);
      return Ok(undefined);
    }

    case "DELETE": {
      if (!decision.memoryId) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "DELETE decision missing memoryId"));
      }
      // Delete the old memory
      const deleteResult = store.delete(decision.memoryId);
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
      const createResult = store.create(replaceInput);
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

// ---------------------------------------------------------------------------
// Heuristic contradiction detection
// ---------------------------------------------------------------------------

/**
 * Heuristic contradiction detection based on negation patterns.
 * Returns true if the two texts appear to contradict each other.
 */
export function heuristicContradiction(a: string, b: string): boolean {
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

// ---------------------------------------------------------------------------
// Content merging
// ---------------------------------------------------------------------------

/**
 * Merge two memory contents. Takes the longer/more detailed version
 * or combines them if they contain complementary information.
 */
export function mergeContent(existing: string, incoming: string): string {
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
