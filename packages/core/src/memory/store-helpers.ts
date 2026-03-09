/**
 * Helper functions, types, and constants for the MemoryStore.
 *
 * Extracted from store.ts (P1-28) to keep the store module focused
 * on CRUD operations and database interaction.
 */

import type { Memory, MemoryLayer, MemoryType } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateMemoryInput {
  readonly type: MemoryType;
  readonly layer: MemoryLayer;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  /** Flag for PII-containing memories that may need special handling (GDPR, encryption). */
  readonly sensitive?: boolean;
  /** User ID for multi-user memory isolation. Defaults to 'default'. */
  readonly userId?: string;
}

export interface UpdateMemoryInput {
  readonly content?: string;
  readonly confidence?: number;
  readonly layer?: MemoryLayer;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  /** Flag for PII-containing memories that may need special handling (GDPR, encryption). */
  readonly sensitive?: boolean;
}

export interface MemoryListOptions {
  readonly types?: readonly MemoryType[];
  readonly layers?: readonly MemoryLayer[];
  readonly minConfidence?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: "created_at" | "updated_at" | "accessed_at" | "confidence";
  readonly order?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Internal row shape from SQLite
// ---------------------------------------------------------------------------

export interface MemoryRow {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly tags: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly accessed_at: number;
  readonly access_count: number;
  readonly metadata: string;
  readonly sensitive: number;
}

// ---------------------------------------------------------------------------
// Validation sets
// ---------------------------------------------------------------------------

export const VALID_MEMORY_TYPES = new Set<string>([
  "fact",
  "preference",
  "decision",
  "episode",
  "skill",
  "relationship",
  "schema",
]);

export const VALID_MEMORY_LAYERS = new Set<string>(["working", "short_term", "long_term", "episodic", "procedural"]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed content length for a single memory entry (1 MB). */
export const MAX_CONTENT_LENGTH = 1_048_576;

/** Maximum number of memories that can be created in a single batch. */
export const MAX_BATCH_SIZE = 1000;

/** Default page size for list queries. */
export const DEFAULT_LIST_LIMIT = 100;

/** Maximum page size for list queries to prevent excessive memory usage. */
export const MAX_LIST_LIMIT = 10_000;

/** Default search result limit. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Maximum search result limit. */
export const MAX_SEARCH_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function validateEnum<T extends string>(value: string, valid: Set<string>, fallback: T): T {
  return valid.has(value) ? (value as T) : fallback;
}

/** Cosine similarity between two Float32Array vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator < 1e-10) return 0;
  return dotProduct / denominator;
}

export function rowToMemory(row: MemoryRow): Memory {
  let tags: string[];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    tags = Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    // Intentional: malformed JSON tags default to empty array
    tags = [];
  }

  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.metadata ?? "{}");
    metadata =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    // Intentional: malformed JSON metadata defaults to empty object
    metadata = {};
  }

  return {
    id: row.id,
    type: validateEnum<MemoryType>(row.type, VALID_MEMORY_TYPES, "fact"),
    layer: validateEnum<MemoryLayer>(row.layer, VALID_MEMORY_LAYERS, "long_term"),
    content: row.content,
    confidence: row.confidence,
    source: row.source,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    accessCount: row.access_count,
    metadata,
    sensitive: row.sensitive === 1,
  };
}
