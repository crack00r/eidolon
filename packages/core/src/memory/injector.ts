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
import type { EidolonError, Memory, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { formatMemoryMarkdown, type KnowledgeGraphContext, sanitizeForMarkdown } from "./injector-format.ts";
import type { CommunityDetector } from "./knowledge-graph/communities.ts";
import type { KGEntityStore } from "./knowledge-graph/entities.ts";
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
  readonly maxCommunities?: number;
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
const DEFAULT_MAX_COMMUNITIES = 3;
const DEFAULT_INCLUDE_KG = true;
const RECENT_HIGH_CONFIDENCE_LIMIT = 10;
const MIN_CONFIDENCE_RECENT = 0.8;

// ---------------------------------------------------------------------------
// MemoryInjector
// ---------------------------------------------------------------------------

export class MemoryInjector {
  private readonly store: MemoryStore;
  private readonly search: MemorySearch;
  private readonly kgEntities: KGEntityStore | null;
  private readonly kgRelations: KGRelationStore | null;
  private readonly communityDetector: CommunityDetector | null;
  private readonly logger: Logger;
  private readonly maxMemories: number;
  private readonly maxKgTriples: number;
  private readonly maxCommunities: number;
  private readonly includeKnowledgeGraph: boolean;
  private readonly contextProviders: readonly ContextProvider[];

  constructor(
    store: MemoryStore,
    search: MemorySearch,
    kgEntities: KGEntityStore | null,
    kgRelations: KGRelationStore | null,
    logger: Logger,
    options?: MemoryInjectorOptions,
    communityDetector?: CommunityDetector | null,
  ) {
    this.store = store;
    this.search = search;
    this.kgEntities = kgEntities;
    this.kgRelations = kgRelations;
    this.communityDetector = communityDetector ?? null;
    this.logger = logger.child("memory-injector");
    this.maxMemories = options?.maxMemories ?? DEFAULT_MAX_MEMORIES;
    this.maxKgTriples = options?.maxKgTriples ?? DEFAULT_MAX_KG_TRIPLES;
    this.maxCommunities = options?.maxCommunities ?? DEFAULT_MAX_COMMUNITIES;
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

      // 2. Collect KG context (entities, triples, communities)
      const kgContext = this.collectKnowledgeGraphContext(context.query);

      // 3. Format markdown
      const md = this.formatMarkdown(context.staticContext, memories, kgContext);

      this.logger.debug("generateMemoryMd", "Generated MEMORY.md", {
        memoryCount: memories.length,
        tripleCount: kgContext.triples.length,
        communityCount: kgContext.communitySummaries.length,
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
  // Private: Knowledge Graph context
  // -----------------------------------------------------------------------

  /**
   * Collect KG context: find entities matching the query, get their triples,
   * and find relevant community summaries.
   * Falls back to global top-N triples when no query or no entity matches.
   */
  private collectKnowledgeGraphContext(query?: string): KnowledgeGraphContext {
    const empty: KnowledgeGraphContext = { triples: [], communitySummaries: [] };

    if (!this.includeKnowledgeGraph) return empty;
    if (this.kgRelations === null) return empty;

    let triples: TripleResult[] = [];
    let communitySummaries: string[] = [];

    // Try to find entities matching the query for context-aware triples
    const matchedEntityIds = this.findRelevantEntityIds(query);

    if (matchedEntityIds.length > 0) {
      // Get triples specifically for the matched entities
      const triplesResult = this.kgRelations.getTriplesForEntities(matchedEntityIds, this.maxKgTriples);
      if (triplesResult.ok) {
        triples = triplesResult.value;
      } else {
        this.logger.warn("collectKnowledgeGraphContext", "Failed to fetch entity triples", {
          error: triplesResult.error.message,
        });
      }

      // Find communities containing these entities
      if (this.communityDetector !== null) {
        const communityResult = this.communityDetector.findCommunitiesForEntities(matchedEntityIds);
        if (communityResult.ok) {
          communitySummaries = communityResult.value
            .slice(0, this.maxCommunities)
            .filter((c) => c.summary.length > 0)
            .map((c) => `**${sanitizeForMarkdown(c.name)}**: ${sanitizeForMarkdown(c.summary)}`);
        } else {
          this.logger.warn("collectKnowledgeGraphContext", "Failed to fetch communities", {
            error: communityResult.error.message,
          });
        }
      }
    }

    // Fall back to global triples if no entity-specific results
    if (triples.length === 0) {
      const globalResult = this.kgRelations.getAllTriples(this.maxKgTriples);
      if (globalResult.ok) {
        triples = globalResult.value;
      } else {
        this.logger.warn("collectKnowledgeGraphContext", "Failed to fetch global KG triples", {
          error: globalResult.error.message,
        });
      }
    }

    return { triples, communitySummaries };
  }

  /**
   * Search for KG entities relevant to the query.
   * Uses prefix search on entity names, splitting the query into words.
   */
  private findRelevantEntityIds(query?: string): string[] {
    if (!query || this.kgEntities === null) return [];

    const entityIds = new Set<string>();
    const words = query.split(/\s+/).filter((w) => w.length >= 2);

    for (const word of words) {
      const result = this.kgEntities.searchByName(word, 5);
      if (result.ok) {
        for (const entity of result.value) {
          entityIds.add(entity.id);
        }
      }
    }

    // Also try exact name match on the full query
    const exactResult = this.kgEntities.findByName(query);
    if (exactResult.ok && exactResult.value !== null) {
      entityIds.add(exactResult.value.id);
    }

    return [...entityIds];
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
  // Private: markdown formatting (delegated to injector-format.ts)
  // -----------------------------------------------------------------------

  private formatMarkdown(
    staticContext: string | undefined,
    memories: readonly Memory[],
    kgContext: KnowledgeGraphContext,
  ): string {
    return formatMemoryMarkdown(staticContext, memories, kgContext, this.contextProviders);
  }
}
