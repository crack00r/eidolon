/**
 * MemoryInjector -- selects relevant memories and formats them into a
 * MEMORY.md file for Claude Code workspace injection.
 *
 * Before each Claude Code session, the injector:
 *   1. Collects static context (user info, preferences)
 *   2. Searches for query-relevant memories via hybrid search
 *   3. Fetches recent high-confidence long-term memories
 *   4. Merges, deduplicates, and groups by type
 *   5. Appends Knowledge Graph triples
 *   6. Writes clean markdown to MEMORY.md
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EidolonError, Memory, MemoryType, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { KGRelationStore, TripleResult } from "./knowledge-graph/relations.ts";
import type { MemorySearch } from "./search.ts";
import type { MemoryStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Options & context
// ---------------------------------------------------------------------------

/**
 * A context provider returns a markdown section to append to MEMORY.md.
 * Used to inject HA state, calendar schedule, etc.
 */
export type ContextProvider = () => Result<string, EidolonError>;

export interface MemoryInjectorOptions {
  readonly maxMemories?: number;
  readonly maxKgTriples?: number;
  readonly includeKnowledgeGraph?: boolean;
  readonly contextProviders?: readonly ContextProvider[];
}

export interface InjectionContext {
  /** The user message / query to find relevant memories for. */
  readonly query?: string;
  /** Additional static context to always include (user info, etc.). */
  readonly staticContext?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_MEMORIES = 20;
const DEFAULT_MAX_KG_TRIPLES = 10;
const DEFAULT_INCLUDE_KG = true;
const RECENT_HIGH_CONFIDENCE_LIMIT = 10;
const MIN_CONFIDENCE_RECENT = 0.8;

// ---------------------------------------------------------------------------
// Display labels for memory types
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<MemoryType, string> = {
  fact: "Facts",
  preference: "Preferences",
  decision: "Decisions",
  episode: "Episodes",
  skill: "Skills",
  relationship: "Relationships",
  schema: "Schemas",
};

/** Desired display order for memory type sections. */
const TYPE_ORDER: readonly MemoryType[] = [
  "fact",
  "preference",
  "decision",
  "skill",
  "episode",
  "relationship",
  "schema",
];

/**
 * Sanitize user-sourced content before embedding in Markdown.
 * Escapes Markdown special characters and replaces newlines with spaces
 * to prevent prompt injection via memory content or KG triple names.
 */
function sanitizeForMarkdown(text: string): string {
  return text.replace(/\n/g, " ").replace(/[#*\->`[\]\\`<]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// MemoryInjector
// ---------------------------------------------------------------------------

export class MemoryInjector {
  private readonly store: MemoryStore;
  private readonly search: MemorySearch;
  private readonly kgRelations: KGRelationStore | null;
  private readonly logger: Logger;
  private readonly maxMemories: number;
  private readonly maxKgTriples: number;
  private readonly includeKnowledgeGraph: boolean;
  private readonly contextProviders: readonly ContextProvider[];

  constructor(
    store: MemoryStore,
    search: MemorySearch,
    _kgEntities: unknown,
    kgRelations: KGRelationStore | null,
    logger: Logger,
    options?: MemoryInjectorOptions,
  ) {
    this.store = store;
    this.search = search;
    this.kgRelations = kgRelations;
    this.logger = logger.child("memory-injector");
    this.maxMemories = options?.maxMemories ?? DEFAULT_MAX_MEMORIES;
    this.maxKgTriples = options?.maxKgTriples ?? DEFAULT_MAX_KG_TRIPLES;
    this.includeKnowledgeGraph = options?.includeKnowledgeGraph ?? DEFAULT_INCLUDE_KG;
    this.contextProviders = options?.contextProviders ?? [];
  }

  /** Generate MEMORY.md content for a session. */
  async generateMemoryMd(context: InjectionContext): Promise<Result<string, EidolonError>> {
    try {
      // 1. Collect memories from search + recent
      const memoriesResult = await this.collectMemories(context);
      if (!memoriesResult.ok) return memoriesResult;

      const memories = memoriesResult.value;

      // 2. Collect KG triples
      let triples: TripleResult[] = [];
      if (this.includeKnowledgeGraph && this.kgRelations !== null) {
        const triplesResult = this.kgRelations.getAllTriples(this.maxKgTriples);
        if (triplesResult.ok) {
          triples = triplesResult.value;
        } else {
          this.logger.warn("generateMemoryMd", "Failed to fetch KG triples", {
            error: triplesResult.error.message,
          });
        }
      }

      // 3. Format markdown
      const md = this.formatMarkdown(context.staticContext, memories, triples);

      this.logger.debug("generateMemoryMd", "Generated MEMORY.md", {
        memoryCount: memories.length,
        tripleCount: triples.length,
        hasStaticContext: context.staticContext !== undefined,
      });

      return Ok(md);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to generate MEMORY.md", cause));
    }
  }

  /** Write MEMORY.md to a workspace directory. */
  async injectIntoWorkspace(workspaceDir: string, context: InjectionContext): Promise<Result<void, EidolonError>> {
    const mdResult = await this.generateMemoryMd(context);
    if (!mdResult.ok) return mdResult;

    try {
      const filePath = join(workspaceDir, "MEMORY.md");
      await writeFile(filePath, mdResult.value, "utf-8");

      this.logger.info("injectIntoWorkspace", `Wrote MEMORY.md to ${filePath}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to write MEMORY.md", cause));
    }
  }

  // -----------------------------------------------------------------------
  // Private: memory collection
  // -----------------------------------------------------------------------

  private async collectMemories(context: InjectionContext): Promise<Result<Memory[], EidolonError>> {
    const memoryMap = new Map<string, Memory>();

    // Search-based memories (if query provided)
    if (context.query) {
      const searchResult = await this.search.search({
        text: context.query,
        limit: this.maxMemories,
      });
      if (!searchResult.ok) return searchResult;

      for (const result of searchResult.value) {
        memoryMap.set(result.memory.id, result.memory);
      }
    }

    // Recent high-confidence long-term memories
    const recentResult = this.store.list({
      layers: ["long_term"],
      minConfidence: MIN_CONFIDENCE_RECENT,
      limit: RECENT_HIGH_CONFIDENCE_LIMIT,
      orderBy: "updated_at",
      order: "desc",
    });
    if (!recentResult.ok) return recentResult;

    for (const memory of recentResult.value) {
      memoryMap.set(memory.id, memory);
    }

    // Enforce max limit
    const all = [...memoryMap.values()];
    return Ok(all.slice(0, this.maxMemories));
  }

  // -----------------------------------------------------------------------
  // Private: markdown formatting
  // -----------------------------------------------------------------------

  private formatMarkdown(
    staticContext: string | undefined,
    memories: readonly Memory[],
    triples: readonly TripleResult[],
  ): string {
    const sections: string[] = ["# Memory Context"];

    // Static context
    if (staticContext) {
      sections.push("");
      sections.push(sanitizeForMarkdown(staticContext));
    }

    // No content at all
    if (memories.length === 0 && triples.length === 0 && !staticContext) {
      sections.push("");
      sections.push("No relevant memories found for this context.");
      return `${sections.join("\n")}\n`;
    }

    // Group memories by type
    if (memories.length > 0) {
      const grouped = this.groupByType(memories);

      sections.push("");
      sections.push("## Key Memories");

      for (const type of TYPE_ORDER) {
        const group = grouped.get(type);
        if (!group || group.length === 0) continue;

        const label = TYPE_LABELS[type];
        sections.push("");
        sections.push(`### ${label}`);
        for (const memory of group) {
          sections.push(`- ${sanitizeForMarkdown(memory.content)}`);
        }
      }
    }

    // Knowledge Graph triples
    if (triples.length > 0) {
      sections.push("");
      sections.push("## Knowledge Graph");
      for (const triple of triples) {
        const subject = sanitizeForMarkdown(triple.subject);
        const predicate = sanitizeForMarkdown(triple.predicate);
        const object = sanitizeForMarkdown(triple.object);
        sections.push(`- ${subject} ${predicate} ${object} (confidence: ${triple.confidence})`);
      }
    }

    // Append context providers (HA state, calendar schedule, etc.)
    for (const provider of this.contextProviders) {
      const result = provider();
      if (result.ok && result.value.length > 0) {
        sections.push("");
        sections.push(result.value);
      }
    }

    return `${sections.join("\n")}\n`;
  }

  private groupByType(memories: readonly Memory[]): Map<MemoryType, Memory[]> {
    const grouped = new Map<MemoryType, Memory[]>();

    for (const memory of memories) {
      const existing = grouped.get(memory.type);
      if (existing) {
        existing.push(memory);
      } else {
        grouped.set(memory.type, [memory]);
      }
    }

    return grouped;
  }
}
