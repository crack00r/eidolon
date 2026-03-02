/**
 * REM Phase (Associative Discovery) -- uses LLM (stubbed for now).
 *
 * 1. Take recent short-term memories (last 7 days by default).
 * 2. For each, find the 5 most semantically similar memories from long-term.
 * 3. Create "related_to" edges between related memories (similarity > 0.3).
 * 4. LLM analysis for non-obvious connections (stubbed: the interface is
 *    defined but the LLM call is not wired to Claude yet).
 * 5. Train ComplEx embeddings on all KG triples (if ComplEx is available).
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { GraphMemory } from "../graph.ts";
import type { ComplExEmbeddings, Triple } from "../knowledge-graph/complex.ts";
import type { KGRelationStore } from "../knowledge-graph/relations.ts";
import type { MemorySearch } from "../search.ts";
import type { MemoryStore } from "../store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemResult {
  readonly edgesCreated: number;
  readonly associationsFound: number;
  readonly complexTrained: boolean;
}

/**
 * LLM function for analyzing connections (injected dependency, stubbed in tests).
 * Takes a recent memory's content and related memories' contents,
 * returns discovered insights with confidence scores.
 */
export type AnalyzeConnectionsFn = (
  recent: string,
  related: readonly string[],
) => Promise<Array<{ insight: string; confidence: number }>>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RECENT_DAYS = 7;
const DEFAULT_MAX_NEIGHBORS = 5;
const MIN_SIMILARITY_FOR_EDGE = 0.3;

// ---------------------------------------------------------------------------
// RemPhase
// ---------------------------------------------------------------------------

export class RemPhase {
  private readonly store: MemoryStore;
  private readonly search: MemorySearch;
  private readonly graph: GraphMemory;
  private readonly complex: ComplExEmbeddings | null;
  private readonly kgRelations: KGRelationStore | null;
  private readonly logger: Logger;

  constructor(
    store: MemoryStore,
    search: MemorySearch,
    graph: GraphMemory,
    complex: ComplExEmbeddings | null,
    kgRelations: KGRelationStore | null,
    logger: Logger,
  ) {
    this.store = store;
    this.search = search;
    this.graph = graph;
    this.complex = complex;
    this.kgRelations = kgRelations;
    this.logger = logger.child("rem");
  }

  /** Run the REM phase. */
  async run(options?: {
    recentDays?: number;
    maxNeighbors?: number;
    analyzeFn?: AnalyzeConnectionsFn;
  }): Promise<Result<RemResult, EidolonError>> {
    try {
      const recentDays = options?.recentDays ?? DEFAULT_RECENT_DAYS;
      const maxNeighbors = options?.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;

      // 1. Get recent short-term memories
      const recentResult = this.store.list({
        layers: ["short_term"],
        orderBy: "created_at",
        order: "desc",
        limit: 100,
      });
      if (!recentResult.ok) return recentResult;

      const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
      const recentMemories = recentResult.value.filter((m) => m.createdAt >= cutoff);

      let edgesCreated = 0;
      let associationsFound = 0;

      // 2. For each recent memory, find similar long-term memories
      for (const recent of recentMemories) {
        const searchResult = await this.search.search({
          text: recent.content,
          limit: maxNeighbors + 1, // +1 to account for self-match
          layers: ["long_term", "episodic", "procedural"],
        });

        if (!searchResult.ok) {
          this.logger.warn("run", `Search failed for memory ${recent.id}`, {
            error: searchResult.error.message,
          });
          continue;
        }

        // Filter out self-match and apply similarity threshold
        const related = searchResult.value
          .filter((r) => r.memory.id !== recent.id && r.score >= MIN_SIMILARITY_FOR_EDGE)
          .slice(0, maxNeighbors);

        associationsFound += related.length;

        // 3. Create edges for related memories
        for (const match of related) {
          // Check if edge already exists
          const existingEdges = this.graph.getOutgoing(recent.id);
          if (existingEdges.ok) {
            const alreadyLinked = existingEdges.value.some(
              (e) => e.targetId === match.memory.id && e.relation === "related_to",
            );
            if (alreadyLinked) continue;
          }

          const edgeResult = this.graph.createEdge({
            sourceId: recent.id,
            targetId: match.memory.id,
            relation: "related_to",
            weight: Math.min(match.score, 1.0),
          });

          if (edgeResult.ok) {
            edgesCreated++;
          }
        }

        // 4. LLM analysis (stubbed) -- if an analyzeFn is provided, call it
        if (options?.analyzeFn && related.length > 0) {
          const relatedContents = related.map((r) => r.memory.content);
          try {
            const insights = await options.analyzeFn(recent.content, relatedContents);
            this.logger.debug("run", `LLM analysis returned ${insights.length} insights`, {
              memoryId: recent.id,
            });
            // Future: create new memories or edges from insights
          } catch {
            this.logger.warn("run", "LLM analysis failed (non-critical)", {
              memoryId: recent.id,
            });
          }
        }
      }

      // 5. Train ComplEx embeddings on all KG triples (if available)
      let complexTrained = false;
      if (this.complex && this.kgRelations) {
        const trainResult = this.trainComplEx();
        complexTrained = trainResult.ok;
      }

      const result: RemResult = {
        edgesCreated,
        associationsFound,
        complexTrained,
      };

      this.logger.info("run", "REM phase complete", {
        recentMemories: recentMemories.length,
        edgesCreated,
        associationsFound,
        complexTrained,
      });

      return Ok(result);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "REM phase failed", cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Collect all triples from KG relations and train ComplEx. */
  private trainComplEx(): Result<void, EidolonError> {
    if (!this.complex || !this.kgRelations) {
      return Ok(undefined);
    }

    const triplesResult = this.kgRelations.getAllTriples(10000);
    if (!triplesResult.ok) return triplesResult;

    const triples: Triple[] = triplesResult.value.map((t) => ({
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
    }));

    if (triples.length === 0) {
      return Ok(undefined);
    }

    const entityIds = [...new Set(triples.flatMap((t) => [t.subject, t.object]))];
    const trainResult = this.complex.train(triples, entityIds);

    if (!trainResult.ok) return trainResult;

    this.logger.debug("trainComplEx", "ComplEx training complete", {
      triples: triples.length,
      loss: trainResult.value.loss,
    });

    return Ok(undefined);
  }
}
