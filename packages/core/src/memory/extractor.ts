/**
 * MemoryExtractor -- auto-extraction of structured memories from conversations.
 *
 * Hybrid strategy:
 * 1. Rule-based (instant, free): regex patterns for dates, names, preferences, etc.
 * 2. LLM-based (optional, costs tokens): injected function analyzes conversation turns
 * 3. Merge: deduplicate extracted memories, keep highest confidence
 *
 * PRIV-001: GDPR consent must be checked before extracting memories.
 * PRIV-006: PII screening marks sensitive memories for special handling.
 */

import type { ConsolidationResult, EidolonError, MemoryType, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { MemoryConsolidator } from "./consolidation.ts";
import type { CreateMemoryInput } from "./store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single extracted memory from a conversation turn. */
export interface ExtractedMemory {
  readonly type: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly tags: readonly string[];
  readonly source: "rule_based" | "llm";
  /** Whether PII was detected in this memory's content. */
  readonly sensitive: boolean;
}

/** Input: a conversation turn (user message + assistant response). */
export interface ConversationTurn {
  readonly userMessage: string;
  readonly assistantResponse: string;
  readonly sessionId?: string;
  readonly timestamp?: number;
}

/** LLM extraction function signature — injected dependency. */
export type LlmExtractFn = (turn: ConversationTurn) => Promise<ExtractedMemory[]>;

/** Consent check function signature — injected dependency. */
export type ConsentCheckFn = () => boolean;

/** Configuration for the MemoryExtractor. */
export interface ExtractorOptions {
  readonly strategy: "rule-based" | "llm" | "hybrid";
  readonly llmExtractFn?: LlmExtractFn;
  readonly minContentLength?: number;
  readonly deduplicateThreshold?: number;
  /** Function to check GDPR consent status. If not provided, extraction always proceeds. */
  readonly consentCheckFn?: ConsentCheckFn;
  /**
   * Optional consolidator for ADD/UPDATE/DELETE/NOOP classification.
   * When provided, extractAndConsolidate() uses it to deduplicate against
   * existing memories before writing to the store.
   */
  readonly consolidator?: MemoryConsolidator;
}

// ---------------------------------------------------------------------------
// PII detection patterns (PRIV-006)
// ---------------------------------------------------------------------------

/** Regex patterns that indicate PII presence in memory content. */
const PII_PATTERNS: readonly RegExp[] = [
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  // Phone numbers (international, US, DE formats)
  /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/,
  // German phone numbers (with area code)
  /0\d{2,4}[-/\s]?\d{4,8}/,
  // Street addresses (number + street name patterns)
  /\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St(?:reet|r\.?)?|Ave(?:nue)?|Rd|Blvd|Dr(?:ive)?|Ln|Way|Pl(?:ace)?|Ct)/i,
  // German addresses (Straße/str. + number)
  /(?:[A-ZÄÖÜ][a-zäöüß]+(?:straße|str\.|weg|gasse|platz|allee))\s+\d{1,5}/i,
  // Postal codes (DE: 5 digits, US: 5 or 5+4)
  /\b\d{5}(?:-\d{4})?\b/,
  // Social security / tax IDs (common patterns)
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Credit card numbers (basic pattern)
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/,
  // IBAN
  /\b[A-Z]{2}\d{2}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{0,2}\b/,
  // Date of birth patterns
  /(?:born|geboren|birthday|geburtstag|dob)[:\s]+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/i,
];

/**
 * Detect if content contains PII patterns.
 * Returns true if any PII pattern matches.
 */
function containsPii(content: string): boolean {
  return PII_PATTERNS.some((pattern) => pattern.test(content));
}

// ---------------------------------------------------------------------------
// Extraction pattern definition
// ---------------------------------------------------------------------------

interface ExtractionPattern {
  readonly pattern: RegExp;
  readonly type: MemoryType;
  readonly confidence: number;
  readonly tag: string;
}

const EXTRACTION_PATTERNS: readonly ExtractionPattern[] = [
  // Explicit memory requests (highest confidence)
  { pattern: /(?:remember|merke dir|merk dir|vergiss nicht)\s+(.+)/i, type: "fact", confidence: 0.95, tag: "explicit" },

  // Preferences
  {
    pattern: /(?:i prefer|ich bevorzuge|ich mag|i like|i want)\s+(.+)/i,
    type: "preference",
    confidence: 0.85,
    tag: "preference",
  },

  // Decisions
  {
    pattern: /(?:let's go with|wir nehmen|we decided|entschieden für|decided on|decided to)\s+(.+)/i,
    type: "decision",
    confidence: 0.9,
    tag: "decision",
  },

  // Corrections (user correcting the assistant)
  {
    pattern: /(?:actually,?|eigentlich,?|nein,|no,|that's wrong,?|das stimmt nicht,?)\s+(.+)/i,
    type: "fact",
    confidence: 0.9,
    tag: "correction",
  },

  // Todos / reminders
  {
    pattern: /(?:TODO|todo|reminder|erinnere|remind me|vergiss nicht zu)\s*:?\s*(.+)/i,
    type: "fact",
    confidence: 0.85,
    tag: "todo",
  },

  // Personal information -- name
  { pattern: /(?:my name is|ich heiße|ich bin)\s+(\w+)/i, type: "fact", confidence: 0.95, tag: "personal" },

  // Personal information -- location
  { pattern: /(?:i live in|ich wohne in|ich lebe in)\s+(.+)/i, type: "fact", confidence: 0.9, tag: "personal" },

  // Personal information -- contact / birthday / address
  {
    pattern: /(?:my (?:email|phone|birthday|address) is)\s+(.+)/i,
    type: "fact",
    confidence: 0.9,
    tag: "personal",
  },
];

// ---------------------------------------------------------------------------
// Trivial-message detection
// ---------------------------------------------------------------------------

/** Acknowledgment patterns that indicate trivial, non-extractable messages. */
const TRIVIAL_PATTERNS: readonly RegExp[] = [
  /^(?:ok|okay|k|yep|yes|yeah|ja|jo|jep|nein|no|nope)\.?$/i,
  /^(?:thanks|thank you|thx|danke|danke schön|dankeschön|merci)\.?!?$/i,
  /^(?:got it|understood|alles klar|verstanden|klar|roger|ack)\.?!?$/i,
  /^(?:👍|👌|✅|🤙|😊|🙏|💯|✔️?|❤️?)$/,
  /^(?:sure|klar|genau|right|correct|stimmt|indeed)\.?!?$/i,
  /^(?:hi|hello|hey|hallo|servus|moin|grüß gott)\.?!?$/i,
];

function isTrivialMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return true;
  return TRIVIAL_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Simple string-based deduplication. Compares content case-insensitively after trimming.
 * Keeps the entry with the higher confidence when duplicates are found.
 */
function deduplicateMemories(memories: readonly ExtractedMemory[]): ExtractedMemory[] {
  const seen = new Map<string, ExtractedMemory>();

  for (const mem of memories) {
    const key = mem.content.trim().toLowerCase();
    const existing = seen.get(key);

    if (!existing || mem.confidence > existing.confidence) {
      seen.set(key, mem);
    }
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// MemoryExtractor
// ---------------------------------------------------------------------------

const DEFAULT_MIN_CONTENT_LENGTH = 10;
const DEFAULT_STRATEGY: ExtractorOptions["strategy"] = "hybrid";
const MAX_EXTRACTED_CONTENT_LENGTH = 10_000;

/**
 * Confidence multiplier for memories extracted from assistant responses.
 * Assistant-sourced content is less reliable than user-sourced content.
 */
const ASSISTANT_CONFIDENCE_MULTIPLIER = 0.8;

const VALID_MEMORY_TYPES = new Set<string>([
  "fact",
  "preference",
  "decision",
  "episode",
  "skill",
  "relationship",
  "schema",
]);

/**
 * Validate and sanitize LLM-extracted memories.
 * Ensures type is valid, confidence is in [0,1], content is bounded, and tags is string[].
 */
function validateExtractedMemory(mem: unknown): ExtractedMemory | null {
  if (typeof mem !== "object" || mem === null) return null;
  const record = mem as Record<string, unknown>;

  // Validate type
  const type =
    typeof record.type === "string" && VALID_MEMORY_TYPES.has(record.type) ? (record.type as MemoryType) : null;
  if (!type) return null;

  // Validate content
  if (typeof record.content !== "string" || record.content.length === 0) return null;
  const content = record.content.slice(0, MAX_EXTRACTED_CONTENT_LENGTH);

  // Clamp confidence to [0, 1]
  const rawConfidence = typeof record.confidence === "number" ? record.confidence : 0.5;
  const confidence = Math.max(0, Math.min(1, Number.isFinite(rawConfidence) ? rawConfidence : 0.5));

  // Ensure tags is string[]
  const tags: readonly string[] = Array.isArray(record.tags)
    ? record.tags.filter((t): t is string => typeof t === "string")
    : [];

  // Validate source
  const source = record.source === "rule_based" || record.source === "llm" ? record.source : "llm";

  // PII screening (PRIV-006)
  const sensitive = containsPii(content);

  return { type, content, confidence, tags, source, sensitive };
}

export class MemoryExtractor {
  private readonly logger: Logger;
  private readonly strategy: ExtractorOptions["strategy"];
  private readonly llmExtractFn?: LlmExtractFn;
  private readonly minContentLength: number;
  private readonly consentCheckFn?: ConsentCheckFn;
  private readonly consolidator?: MemoryConsolidator;

  constructor(logger: Logger, options?: ExtractorOptions) {
    this.logger = logger.child("memory-extractor");
    this.strategy = options?.strategy ?? DEFAULT_STRATEGY;
    this.llmExtractFn = options?.llmExtractFn;
    this.minContentLength = options?.minContentLength ?? DEFAULT_MIN_CONTENT_LENGTH;
    this.consentCheckFn = options?.consentCheckFn;
    this.consolidator = options?.consolidator;
  }

  /**
   * Extract memories from a conversation turn using the configured strategy.
   * Returns Ok with extracted memories or Err on failure.
   *
   * PRIV-001: Checks GDPR consent before proceeding. If consent is not
   * granted and a consentCheckFn was provided, returns empty array with warning.
   */
  async extract(turn: ConversationTurn): Promise<Result<ExtractedMemory[], EidolonError>> {
    try {
      // PRIV-001: Check GDPR consent before extracting
      if (this.consentCheckFn && !this.consentCheckFn()) {
        this.logger.warn(
          "extract",
          "Memory extraction skipped: GDPR consent not granted. Run 'eidolon privacy consent --grant' to enable.",
        );
        return Ok([]);
      }

      if (!MemoryExtractor.isWorthExtracting(turn)) {
        return Ok([]);
      }

      const ruleBased = this.strategy !== "llm" ? this.extractRuleBased(turn) : [];

      const llmBased: ExtractedMemory[] = [];
      if (this.strategy !== "rule-based" && this.llmExtractFn) {
        try {
          const rawResults = await this.llmExtractFn(turn);
          // Validate each LLM-extracted entry to prevent malformed data
          for (const raw of rawResults) {
            const validated = validateExtractedMemory(raw);
            if (validated) {
              llmBased.push(validated);
            } else {
              this.logger.warn("extract", "Dropped invalid LLM extraction result", {
                raw: String(raw),
              });
            }
          }
        } catch (cause) {
          this.logger.warn("extract", "LLM extraction failed, falling back to rule-based only", {
            error: String(cause),
          });
          // If strategy is "llm" only and it fails, return the error
          if (this.strategy === "llm") {
            return Err(createError(ErrorCode.MEMORY_EXTRACTION_FAILED, "LLM extraction failed", cause));
          }
          // For hybrid, we continue with rule-based results
        }
      }

      const merged = deduplicateMemories([...ruleBased, ...llmBased]);

      // Log PII detections
      const sensitiveCount = merged.filter((m) => m.sensitive).length;
      if (sensitiveCount > 0) {
        this.logger.info(
          "extract",
          `PII detected in ${sensitiveCount} of ${merged.length} extracted memories — flagged as sensitive`,
        );
      }

      this.logger.debug("extract", `Extracted ${merged.length} memories`, {
        ruleBasedCount: ruleBased.length,
        llmCount: llmBased.length,
        mergedCount: merged.length,
        sensitiveCount,
        strategy: this.strategy,
      });

      return Ok(merged);
    } catch (cause) {
      return Err(createError(ErrorCode.MEMORY_EXTRACTION_FAILED, "Memory extraction failed", cause));
    }
  }

  /**
   * Rule-based extraction only (synchronous, free).
   * Applies regex patterns to both user message and assistant response.
   * PRIV-006: Screens extracted content for PII and marks sensitive.
   */
  extractRuleBased(turn: ConversationTurn): ExtractedMemory[] {
    const results: ExtractedMemory[] = [];

    // Extract from user message (primary source)
    for (const entry of EXTRACTION_PATTERNS) {
      const match = entry.pattern.exec(turn.userMessage);
      if (match?.[1]) {
        const content = match[1].trim();
        if (content.length >= this.minContentLength) {
          results.push({
            type: entry.type,
            content,
            confidence: entry.confidence,
            tags: [entry.tag],
            source: "rule_based",
            sensitive: containsPii(content),
          });
        }
      }
    }

    // Extract from assistant response (lower confidence since it's generated)
    for (const entry of EXTRACTION_PATTERNS) {
      const match = entry.pattern.exec(turn.assistantResponse);
      if (match?.[1]) {
        const content = match[1].trim();
        if (content.length >= this.minContentLength) {
          results.push({
            type: entry.type,
            content,
            confidence: entry.confidence * ASSISTANT_CONFIDENCE_MULTIPLIER, // Lower confidence for assistant-sourced
            tags: [entry.tag, "assistant-sourced"],
            source: "rule_based",
            sensitive: containsPii(content),
          });
        }
      }
    }

    return deduplicateMemories(results);
  }

  /**
   * Convert extracted memories to CreateMemoryInput format for MemoryStore.
   * Extracted memories start in the "short_term" layer — promotion happens during dreaming.
   * PRIV-006: Passes through the sensitive flag from PII screening.
   */
  toCreateInputs(extracted: readonly ExtractedMemory[], sessionId?: string): CreateMemoryInput[] {
    return extracted.map((mem) => ({
      type: mem.type,
      layer: "short_term" as const,
      content: mem.content,
      confidence: mem.confidence,
      source: `extraction:${mem.source}`,
      tags: [...mem.tags],
      metadata: sessionId ? { sessionId } : undefined,
      sensitive: mem.sensitive,
    }));
  }

  /**
   * Extract memories from a conversation turn and run consolidation
   * (ADD/UPDATE/DELETE/NOOP) against the existing store before writing.
   *
   * This is the recommended high-level method when a consolidator is configured.
   * If no consolidator was injected, this falls back to plain extraction
   * (equivalent to calling extract() + toCreateInputs() manually).
   *
   * Returns the consolidation result with action counts, or Ok with zero
   * counts if consolidation is not configured.
   */
  async extractAndConsolidate(
    turn: ConversationTurn,
    sessionId?: string,
  ): Promise<Result<ConsolidationResult, EidolonError>> {
    // 1. Extract memories from the conversation turn
    const extractResult = await this.extract(turn);
    if (!extractResult.ok) {
      return Err(extractResult.error);
    }

    const extracted = extractResult.value;
    if (extracted.length === 0) {
      return Ok({ decisions: [], added: 0, updated: 0, deleted: 0, noops: 0 });
    }

    // 2. If consolidator is available, use it for smart deduplication
    if (this.consolidator) {
      this.logger.debug("extractAndConsolidate", `Running consolidation on ${extracted.length} extracted memories`);
      const consolidateResult = await this.consolidator.consolidate(extracted, sessionId);
      if (!consolidateResult.ok) {
        this.logger.warn(
          "extractAndConsolidate",
          `Consolidation failed: ${consolidateResult.error.message}. Falling back to direct store writes.`,
        );
        // Fall through to direct store writes below
      } else {
        this.logger.info("extractAndConsolidate", "Consolidation complete", {
          added: consolidateResult.value.added,
          updated: consolidateResult.value.updated,
          deleted: consolidateResult.value.deleted,
          noops: consolidateResult.value.noops,
        });
        return consolidateResult;
      }
    }

    // 3. Fallback: no consolidator or consolidation failed -- return ADD-only result
    //    The caller is responsible for writing to the store using toCreateInputs().
    this.logger.debug(
      "extractAndConsolidate",
      `No consolidator available. Returning ${extracted.length} memories as ADD decisions.`,
    );
    return Ok({
      decisions: extracted.map((mem) => ({
        action: "ADD" as const,
        content: mem.content,
        confidence: mem.confidence,
        reason: "No consolidator configured -- direct ADD",
      })),
      added: extracted.length,
      updated: 0,
      deleted: 0,
      noops: 0,
    });
  }

  /**
   * Check if a turn is worth extracting from (skip trivial messages).
   * Static so it can be called without instantiation.
   */
  static isWorthExtracting(turn: ConversationTurn): boolean {
    const userMsg = turn.userMessage.trim();
    const assistantMsg = turn.assistantResponse.trim();

    // Skip empty messages
    if (userMsg.length === 0 && assistantMsg.length === 0) {
      return false;
    }

    // Skip if user message is trivial
    if (isTrivialMessage(userMsg)) {
      // Even if user message is trivial, assistant might have said something worth extracting
      // But only if the assistant response is non-trivial and substantial
      return assistantMsg.length >= DEFAULT_MIN_CONTENT_LENGTH && !isTrivialMessage(assistantMsg);
    }

    // Skip if both are very short
    if (userMsg.length < DEFAULT_MIN_CONTENT_LENGTH && assistantMsg.length < DEFAULT_MIN_CONTENT_LENGTH) {
      return false;
    }

    return true;
  }
}
