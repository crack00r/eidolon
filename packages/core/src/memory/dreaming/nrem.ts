/**
 * NREM Phase (Schema Abstraction) -- wired to real LLM calls via ModelRouter.
 *
 * 1. Promote eligible short-term memories to long_term.
 * 2. Run Leiden community detection on KG relations.
 * 3. Use LLM to generate community summaries (fast model tier).
 * 4. Cluster long-term memories by type and abstract rules via LLM.
 * 5. Extract skill memories from recurring patterns.
 * 6. Graceful degradation: all LLM steps are skipped if no provider is available.
 */

import type { EidolonError, ILLMProvider, IModelRouter, KGCommunity, Memory, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { CommunityDetector } from "../knowledge-graph/communities.ts";
import type { MemoryStore } from "../store.ts";
import { buildCommunitySummaryPrompt, buildRuleAbstractionPrompt } from "./nrem-prompts.ts";
import { extractSkills as extractSkillsImpl } from "./nrem-skills.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NremResult {
  readonly memoriesPromoted: number;
  readonly schemasCreated: number;
  readonly skillsExtracted: number;
  readonly communitiesDetected: number;
  readonly communitiesSummarized: number;
  readonly tokensUsed: number;
}

/**
 * LLM function for abstracting rules from a cluster of similar memories.
 * Returns a general rule/schema string, or null if no abstraction is possible.
 */
export type AbstractRuleFn = (memories: readonly string[]) => Promise<string | null>;

export interface NremOptions {
  readonly minClusterSize?: number;
  readonly promotionConfidence?: number;
  /** Legacy injected function -- used only if no router is provided. */
  readonly abstractFn?: AbstractRuleFn;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_CLUSTER_SIZE = 3;
const DEFAULT_PROMOTION_CONFIDENCE = 0.7;
const PROMOTION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_COMMUNITY_SUMMARY_TOKENS = 512;
const MAX_RULE_ABSTRACTION_TOKENS = 512;

// ---------------------------------------------------------------------------
// NremPhase
// ---------------------------------------------------------------------------

export class NremPhase {
  private readonly store: MemoryStore;
  private readonly logger: Logger;
  private readonly router: IModelRouter | null;
  private readonly communityDetector: CommunityDetector | null;

  constructor(
    store: MemoryStore,
    logger: Logger,
    router?: IModelRouter | null,
    communityDetector?: CommunityDetector | null,
  ) {
    this.store = store;
    this.logger = logger.child("nrem");
    this.router = router ?? null;
    this.communityDetector = communityDetector ?? null;
  }

  /** Run the NREM phase. */
  async run(options?: NremOptions): Promise<Result<NremResult, EidolonError>> {
    try {
      const minClusterSize = options?.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
      const promotionConfidence = options?.promotionConfidence ?? DEFAULT_PROMOTION_CONFIDENCE;
      let tokensUsed = 0;

      // 1. Promote eligible short-term memories to long_term
      const promotionResult = this.promoteMemories(promotionConfidence);
      if (!promotionResult.ok) return promotionResult;
      const memoriesPromoted = promotionResult.value;

      // 2. Run community detection
      let communitiesDetected = 0;
      let communitiesSummarized = 0;
      if (this.communityDetector) {
        const cdResult = this.communityDetector.detectCommunities();
        if (cdResult.ok) {
          communitiesDetected = cdResult.value.length;
          this.logger.info("run", `Detected ${communitiesDetected} communities`);

          // 3. Summarize communities via LLM
          const summaryResult = await this.summarizeCommunities(cdResult.value);
          communitiesSummarized = summaryResult.count;
          tokensUsed += summaryResult.tokens;
        } else {
          this.logger.warn("run", "Community detection failed (non-critical)", {
            error: cdResult.error.message,
          });
        }
      }

      // 4. Schema abstraction
      let schemasCreated = 0;
      const schemaResult = await this.abstractSchemas(minClusterSize, options?.abstractFn);
      if (schemaResult.ok) {
        schemasCreated = schemaResult.value.count;
        tokensUsed += schemaResult.value.tokens;
      }

      // 5. Skill extraction
      let skillsExtracted = 0;
      const skillProvider = await this.resolveProvider();
      const skillResult = await extractSkillsImpl(this.store, skillProvider, this.logger);
      skillsExtracted = skillResult.count;
      tokensUsed += skillResult.tokens;

      const result: NremResult = {
        memoriesPromoted,
        schemasCreated,
        skillsExtracted,
        communitiesDetected,
        communitiesSummarized,
        tokensUsed,
      };

      this.logger.info("run", "NREM phase complete", { ...result });

      return Ok(result);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "NREM phase failed", cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private: Memory promotion
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Private: Community summarization via LLM
  // -------------------------------------------------------------------------

  private async summarizeCommunities(communities: readonly KGCommunity[]): Promise<{ count: number; tokens: number }> {
    if (communities.length === 0) return { count: 0, tokens: 0 };

    const provider = await this.resolveProvider();
    if (!provider) {
      this.logger.debug("summarizeCommunities", "No LLM provider available, using built-in summaries");
      let count = 0;
      for (const community of communities) {
        if (this.communityDetector) {
          const summaryResult = this.communityDetector.summarizeCommunity(community.id);
          if (summaryResult.ok) count++;
        }
      }
      return { count, tokens: 0 };
    }

    let summarized = 0;
    let totalTokens = 0;

    for (const community of communities) {
      if (!this.communityDetector) continue;
      const structuralResult = this.communityDetector.summarizeCommunity(community.id);
      if (!structuralResult.ok) continue;

      const prompt = buildCommunitySummaryPrompt(community.name, structuralResult.value);
      try {
        const completion = await provider.complete(
          [
            { role: "system", content: "You are a knowledge graph analyst. Generate concise community summaries." },
            { role: "user", content: prompt },
          ],
          { temperature: 0.3, maxTokens: MAX_COMMUNITY_SUMMARY_TOKENS },
        );

        totalTokens += completion.usage.inputTokens + completion.usage.outputTokens;

        if (completion.content.trim().length > 0) {
          this.communityDetector.updateSummary(community.id, completion.content.trim());
          summarized++;
        }
      } catch (error) {
        this.logger.warn("summarizeCommunities", `LLM summarization failed for community ${community.id}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { count: summarized, tokens: totalTokens };
  }

  // -------------------------------------------------------------------------
  // Private: Schema abstraction via LLM
  // -------------------------------------------------------------------------

  private async abstractSchemas(
    minClusterSize: number,
    legacyFn?: AbstractRuleFn,
  ): Promise<Result<{ count: number; tokens: number }, EidolonError>> {
    const listResult = this.store.list({
      layers: ["long_term"],
      limit: 500,
      orderBy: "created_at",
      order: "desc",
    });
    if (!listResult.ok) return listResult;

    const byType = new Map<string, Memory[]>();
    for (const mem of listResult.value) {
      if (mem.type === "schema") continue;
      const list = byType.get(mem.type) ?? [];
      list.push(mem);
      byType.set(mem.type, list);
    }

    let schemasCreated = 0;
    let totalTokens = 0;

    for (const [type, mems] of byType) {
      if (mems.length < minClusterSize) continue;

      const contents = mems.map((m) => m.content);

      try {
        let rule: string | null = null;
        let tokens = 0;

        const provider = await this.resolveProvider();
        if (provider) {
          const result = await this.abstractRuleViaLlm(provider, type, contents);
          rule = result.rule;
          tokens = result.tokens;
        } else if (legacyFn) {
          rule = await legacyFn(contents);
        } else {
          this.logger.debug("abstractSchemas", `No LLM available, skipping schema for type ${type}`);
          continue;
        }

        totalTokens += tokens;

        if (rule) {
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

    return Ok({ count: schemasCreated, tokens: totalTokens });
  }

  private async abstractRuleViaLlm(
    provider: ILLMProvider,
    type: string,
    contents: readonly string[],
  ): Promise<{ rule: string | null; tokens: number }> {
    const prompt = buildRuleAbstractionPrompt(type, contents);

    const completion = await provider.complete(
      [
        {
          role: "system",
          content:
            "You are an analytical assistant that identifies general rules and patterns from specific observations. Respond with ONLY the rule or pattern, no preamble.",
        },
        { role: "user", content: prompt },
      ],
      { temperature: 0.3, maxTokens: MAX_RULE_ABSTRACTION_TOKENS },
    );

    const tokens = completion.usage.inputTokens + completion.usage.outputTokens;
    const rule = completion.content.trim();

    return { rule: rule.length > 0 ? rule : null, tokens };
  }

  // -------------------------------------------------------------------------
  // Private: LLM provider resolution
  // -------------------------------------------------------------------------

  private async resolveProvider(): Promise<ILLMProvider | null> {
    if (!this.router) return null;

    try {
      const provider = await this.router.selectProvider({ type: "dreaming" });
      if (!provider) {
        this.logger.debug("resolveProvider", "No LLM provider available for dreaming tasks");
        return null;
      }
      return provider;
    } catch {
      this.logger.debug("resolveProvider", "Failed to select LLM provider");
      return null;
    }
  }
}
