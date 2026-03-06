/**
 * REM Phase (Associative Discovery) -- uses LLM for non-obvious connections.
 *
 * 1. Take recent short-term memories (last 7 days by default).
 * 2. For each, find the 5 most semantically similar memories from long-term.
 * 3. Create "related_to" edges between related memories (similarity > 0.3).
 * 4. LLM analysis: ask a fast model to find non-obvious connections between
 *    memory pairs, create edges and association memories from insights.
 * 5. Train ComplEx embeddings on all KG triples (if ComplEx is available).
 */

import type { EidolonError, ILLMProvider, LLMMessage, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { ModelRouter } from "../../llm/router.ts";
import type { GraphMemory } from "../graph.ts";
import { ComplExEmbeddings } from "../knowledge-graph/complex.ts";
import type { Triple } from "../knowledge-graph/complex.ts";
import type { KGRelationStore, RelationPredicate } from "../knowledge-graph/relations.ts";
import type { MemorySearch } from "../search.ts";
import type { MemoryStore } from "../store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemResult {
  readonly edgesCreated: number;
  readonly associationsFound: number;
  readonly memoriesCreated: number;
  readonly tokensUsed: number;
  readonly complexTrained: boolean;
  readonly predictionsCreated: number;
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

/** Parsed insight from the LLM response. */
interface LlmInsight {
  readonly insight: string;
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RECENT_DAYS = 7;
const DEFAULT_MAX_NEIGHBORS = 5;
const MIN_SIMILARITY_FOR_EDGE = 0.3;
const MIN_INSIGHT_CONFIDENCE = 0.5;
const MIN_PREDICTION_CONFIDENCE = 0.7;

const ASSOCIATION_PROMPT_SYSTEM = `You are a memory analysis system. Given a recent memory and a list of related memories, find non-obvious connections, patterns, or insights that link them. Focus on connections that are NOT immediately apparent from surface-level similarity.

Respond ONLY with a JSON array of objects. Each object must have:
- "insight": a concise description of the connection (1-2 sentences)
- "confidence": a number from 0.0 to 1.0 indicating how confident you are

Example response:
[{"insight":"Both memories reference TypeScript preferences, suggesting the user consistently favors typed languages for reliability.","confidence":0.85}]

If no non-obvious connections exist, return an empty array: []`;

// ---------------------------------------------------------------------------
// RemPhase
// ---------------------------------------------------------------------------

export class RemPhase {
  private readonly store: MemoryStore;
  private readonly search: MemorySearch;
  private readonly graph: GraphMemory;
  private readonly complex: ComplExEmbeddings | null;
  private readonly kgRelations: KGRelationStore | null;
  private readonly router: ModelRouter | null;
  private readonly logger: Logger;

  constructor(
    store: MemoryStore,
    search: MemorySearch,
    graph: GraphMemory,
    complex: ComplExEmbeddings | null,
    kgRelations: KGRelationStore | null,
    logger: Logger,
    router?: ModelRouter | null,
  ) {
    this.store = store;
    this.search = search;
    this.graph = graph;
    this.complex = complex;
    this.kgRelations = kgRelations;
    this.router = router ?? null;
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
      let memoriesCreated = 0;
      let tokensUsed = 0;

      // Resolve the LLM provider once (use "dreaming" task type, fast tier)
      const llmProvider = await this.resolveLlmProvider();

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

        // 4. LLM analysis for non-obvious connections
        if (related.length > 0) {
          const relatedContents = related.map((r) => r.memory.content);
          const llmResult = await this.analyzeWithLlm(
            recent.content,
            relatedContents,
            llmProvider,
            options?.analyzeFn,
          );

          tokensUsed += llmResult.tokensUsed;

          // Create association memories from high-confidence insights
          for (const insight of llmResult.insights) {
            if (insight.confidence >= MIN_INSIGHT_CONFIDENCE) {
              const createResult = this.store.create({
                type: "relationship",
                layer: "long_term",
                content: insight.insight,
                confidence: insight.confidence,
                source: "dreaming:rem",
                tags: ["association", "rem-discovery"],
              });

              if (createResult.ok) {
                memoriesCreated++;

                // Create edge from the source memory to the new association
                this.graph.createEdge({
                  sourceId: recent.id,
                  targetId: createResult.value.id,
                  relation: "related_to",
                  weight: insight.confidence,
                });
                edgesCreated++;
              }
            }
          }
        }
      }

      // 5. Train ComplEx embeddings on all KG triples (if available)
      let complexTrained = false;
      let predictionsCreated = 0;
      if (this.complex && this.kgRelations) {
        const trainResult = this.trainComplEx();
        complexTrained = trainResult.ok;

        // 6. Predict new links and store high-confidence predictions
        if (complexTrained) {
          const predResult = this.predictAndStoreLinks();
          if (predResult.ok) {
            predictionsCreated = predResult.value;
          }
        }
      }

      const result: RemResult = {
        edgesCreated,
        associationsFound,
        memoriesCreated,
        tokensUsed,
        complexTrained,
        predictionsCreated,
      };

      this.logger.info("run", "REM phase complete", {
        recentMemories: recentMemories.length,
        edgesCreated,
        associationsFound,
        memoriesCreated,
        tokensUsed,
        complexTrained,
        predictionsCreated,
      });

      return Ok(result);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "REM phase failed", cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Resolve the LLM provider for dreaming tasks. Returns null if unavailable. */
  private async resolveLlmProvider(): Promise<ILLMProvider | null> {
    if (!this.router) {
      this.logger.debug("resolveLlmProvider", "No LLM router configured, skipping LLM analysis");
      return null;
    }

    try {
      const provider = await this.router.selectProvider({ type: "dreaming" });
      if (!provider) {
        this.logger.warn("resolveLlmProvider", "No LLM provider available for dreaming tasks");
        return null;
      }
      return provider;
    } catch {
      this.logger.warn("resolveLlmProvider", "Failed to resolve LLM provider, degrading gracefully");
      return null;
    }
  }

  /**
   * Analyze a recent memory against related memories using the LLM or a custom
   * analyzeFn. Falls back gracefully if neither is available.
   */
  private async analyzeWithLlm(
    recentContent: string,
    relatedContents: readonly string[],
    provider: ILLMProvider | null,
    analyzeFn?: AnalyzeConnectionsFn,
  ): Promise<{ insights: readonly LlmInsight[]; tokensUsed: number }> {
    // Prefer custom analyzeFn if provided (e.g. in tests)
    if (analyzeFn) {
      try {
        const insights = await analyzeFn(recentContent, relatedContents);
        return { insights, tokensUsed: 0 };
      } catch {
        this.logger.warn("analyzeWithLlm", "Custom analyzeFn failed (non-critical)");
        return { insights: [], tokensUsed: 0 };
      }
    }

    // No provider available -- skip LLM analysis gracefully
    if (!provider) {
      return { insights: [], tokensUsed: 0 };
    }

    try {
      const messages = this.buildAssociationPrompt(recentContent, relatedContents);
      const completion = await provider.complete(messages, {
        temperature: 0.7,
        maxTokens: 512,
      });

      const insights = this.parseInsightsResponse(completion.content);
      const tokens = completion.usage.inputTokens + completion.usage.outputTokens;

      this.logger.debug("analyzeWithLlm", `LLM returned ${insights.length} insights`, {
        tokensUsed: tokens,
      });

      return { insights, tokensUsed: tokens };
    } catch {
      this.logger.warn("analyzeWithLlm", "LLM call failed (non-critical), skipping");
      return { insights: [], tokensUsed: 0 };
    }
  }

  /** Build the prompt messages for associative discovery. */
  private buildAssociationPrompt(
    recentContent: string,
    relatedContents: readonly string[],
  ): readonly LLMMessage[] {
    const relatedList = relatedContents
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");

    const userMessage = `Recent memory:\n"${recentContent}"\n\nRelated memories:\n${relatedList}\n\nFind non-obvious connections between the recent memory and the related memories. Return JSON only.`;

    return [
      { role: "system", content: ASSOCIATION_PROMPT_SYSTEM },
      { role: "user", content: userMessage },
    ];
  }

  /** Parse the LLM response into structured insights. */
  private parseInsightsResponse(content: string): readonly LlmInsight[] {
    try {
      // Extract JSON from the response (handle markdown fences)
      let jsonStr = content.trim();
      const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(jsonStr);
      if (fenceMatch?.[1]) {
        jsonStr = fenceMatch[1].trim();
      }

      const parsed: unknown = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        this.logger.warn("parseInsightsResponse", "LLM response is not an array");
        return [];
      }

      const insights: LlmInsight[] = [];
      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          "insight" in item &&
          "confidence" in item &&
          typeof (item as Record<string, unknown>).insight === "string" &&
          typeof (item as Record<string, unknown>).confidence === "number"
        ) {
          const raw = item as { insight: string; confidence: number };
          insights.push({
            insight: raw.insight,
            confidence: Math.max(0, Math.min(1, raw.confidence)),
          });
        }
      }

      return insights;
    } catch {
      this.logger.warn("parseInsightsResponse", "Failed to parse LLM response as JSON");
      return [];
    }
  }

  /** Collect all triples from KG relations (using entity IDs) and train ComplEx. */
  private trainComplEx(): Result<void, EidolonError> {
    if (!this.complex || !this.kgRelations) {
      return Ok(undefined);
    }

    const triplesResult = this.kgRelations.getAllTriplesWithIds(10000);
    if (!triplesResult.ok) return triplesResult;

    const triples: Triple[] = triplesResult.value.map((t) => ({
      subject: t.subjectId,
      predicate: t.predicate,
      object: t.objectId,
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

  /**
   * Predict new links using trained ComplEx embeddings and store high-confidence
   * predictions as new relations with source='prediction'.
   */
  private predictAndStoreLinks(): Result<number, EidolonError> {
    if (!this.complex || !this.kgRelations) {
      return Ok(0);
    }

    const triplesResult = this.kgRelations.getAllTriplesWithIds(10000);
    if (!triplesResult.ok) return triplesResult;

    if (triplesResult.value.length === 0) {
      return Ok(0);
    }

    const entityIds = [...new Set(triplesResult.value.flatMap((t) => [t.subjectId, t.objectId]))];
    const predicates = [...new Set(triplesResult.value.map((t) => t.predicate))];

    // Build a set of existing triples for fast lookup
    const existingTriples = new Set(
      triplesResult.value.map((t) => `${t.subjectId}|${t.predicate}|${t.objectId}`),
    );

    let created = 0;

    for (const entityId of entityIds) {
      const predictions = this.complex.predictLinks(entityId, predicates, entityIds, 5);
      if (!predictions.ok) continue;

      for (const pred of predictions.value) {
        // Skip if triple already exists or score is too low
        const key = `${pred.subject}|${pred.predicate}|${pred.object}`;
        if (existingTriples.has(key)) continue;
        if (pred.score < MIN_PREDICTION_CONFIDENCE) continue;

        // Validate that the predicate is a valid RelationPredicate before creating
        const createResult = this.kgRelations.create({
          sourceId: pred.subject,
          targetId: pred.object,
          type: pred.predicate as RelationPredicate,
          confidence: Math.min(ComplExEmbeddings.sigmoid(pred.score), 0.9),
          source: "prediction",
        });

        if (createResult.ok) {
          created++;
          existingTriples.add(key);
        }
      }
    }

    this.logger.debug("predictAndStoreLinks", `Stored ${created} predicted relations`, {
      totalEntities: entityIds.length,
      totalPredicates: predicates.length,
    });

    return Ok(created);
  }
}
