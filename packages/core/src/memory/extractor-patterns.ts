/**
 * Extraction patterns, PII detection, and helper functions for the MemoryExtractor.
 *
 * Extracted from extractor.ts (P1-30) to keep the extractor module focused
 * on the extraction orchestration logic (hybrid strategy, consolidation).
 */

import type { MemoryType } from "@eidolon/protocol";
import type { ExtractedMemory } from "./extractor.ts";

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
  // German addresses (Strasse/str. + number)
  /(?:[A-ZUOU][a-zuouß]+(?:straße|str\.|weg|gasse|platz|allee))\s+\d{1,5}/i,
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
export function containsPii(content: string): boolean {
  return PII_PATTERNS.some((pattern) => pattern.test(content));
}

// ---------------------------------------------------------------------------
// Extraction pattern definition
// ---------------------------------------------------------------------------

export interface ExtractionPattern {
  readonly pattern: RegExp;
  readonly type: MemoryType;
  readonly confidence: number;
  readonly tag: string;
}

export const EXTRACTION_PATTERNS: readonly ExtractionPattern[] = [
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
  /^(?:\u{1F44D}|\u{1F44C}|\u{2705}|\u{1F919}|\u{1F60A}|\u{1F64F}|\u{1F4AF}|\u{2714}\u{FE0F}?|\u{2764}\u{FE0F}?)$/u,
  /^(?:sure|klar|genau|right|correct|stimmt|indeed)\.?!?$/i,
  /^(?:hi|hello|hey|hallo|servus|moin|grüß gott)\.?!?$/i,
];

export function isTrivialMessage(message: string): boolean {
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
export function deduplicateMemories(memories: readonly ExtractedMemory[]): ExtractedMemory[] {
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
// LLM result validation
// ---------------------------------------------------------------------------

const VALID_MEMORY_TYPES = new Set<string>([
  "fact",
  "preference",
  "decision",
  "episode",
  "skill",
  "relationship",
  "schema",
]);

/** Maximum content length for a single extracted memory. */
export const MAX_EXTRACTED_CONTENT_LENGTH = 10_000;

/**
 * Validate and sanitize LLM-extracted memories.
 * Ensures type is valid, confidence is in [0,1], content is bounded, and tags is string[].
 */
export function validateExtractedMemory(mem: unknown): ExtractedMemory | null {
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
