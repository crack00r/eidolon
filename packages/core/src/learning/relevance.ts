/**
 * RelevanceFilter -- scores content relevance against user interests.
 *
 * Two-tier scoring:
 *   1. Keyword matching (free, instant) -- checks title/content for interest matches.
 *   2. LLM scoring (optional, costs tokens) -- used when keyword score is borderline.
 *
 * Scoring rules:
 *   - Each matched interest: +0.2 (capped at 1.0)
 *   - Exact phrase match bonus: +0.3
 *   - Common tech keyword bonus: +0.1
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

export interface RelevanceConfig {
  readonly minScore: number;
  readonly userInterests: readonly string[];
}

export interface RelevanceResult {
  readonly score: number;
  readonly reason: string;
  readonly matchedInterests: readonly string[];
}

/** LLM-based relevance scoring function (injected dependency). */
export type RelevanceScorerFn = (
  title: string,
  content: string,
  interests: readonly string[],
) => Promise<RelevanceResult>;

const TECH_KEYWORDS = [
  "typescript",
  "javascript",
  "ai",
  "artificial intelligence",
  "machine learning",
  "bun",
  "deno",
  "node",
  "rust",
  "python",
  "llm",
  "large language model",
  "claude",
  "gpt",
  "transformer",
  "sqlite",
  "tauri",
  "electron",
  "react",
  "svelte",
  "webassembly",
  "wasm",
] as const;

/** Borderline score zone where LLM scoring is triggered. */
const BORDERLINE_LOW = 0.3;
const BORDERLINE_HIGH = 0.7;

export class RelevanceFilter {
  private readonly config: RelevanceConfig;
  private readonly logger: Logger;

  constructor(config: RelevanceConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child("relevance");
  }

  /** Score content relevance using keyword matching (free, instant). */
  scoreKeywords(title: string, content: string): RelevanceResult {
    const combined = `${title} ${content}`.toLowerCase();
    const matchedInterests: string[] = [];
    let score = 0;

    for (const interest of this.config.userInterests) {
      const lowerInterest = interest.toLowerCase();

      // Check for exact phrase match (higher bonus)
      if (combined.includes(lowerInterest)) {
        if (!matchedInterests.includes(interest)) {
          matchedInterests.push(interest);
        }

        // Exact phrase in title gets the full bonus
        if (title.toLowerCase().includes(lowerInterest)) {
          score += 0.3;
        } else {
          score += 0.2;
        }
      }
    }

    // Tech keyword bonus
    for (const keyword of TECH_KEYWORDS) {
      if (combined.includes(keyword)) {
        score += 0.1;
        break; // Only one tech bonus
      }
    }

    score = Math.min(score, 1.0);

    const reason =
      matchedInterests.length > 0 ? `Matched interests: ${matchedInterests.join(", ")}` : "No interest matches found";

    return { score, reason, matchedInterests };
  }

  /** Score content using LLM (optional, costs tokens). */
  async scoreLlm(
    title: string,
    content: string,
    scorerFn: RelevanceScorerFn,
  ): Promise<Result<RelevanceResult, EidolonError>> {
    try {
      const result = await scorerFn(title, content, this.config.userInterests);
      this.logger.debug("scoreLlm", `LLM scored: ${result.score}`, {
        title,
        score: result.score,
      });
      return Ok(result);
    } catch (cause) {
      return Err(createError(ErrorCode.DISCOVERY_FAILED, `LLM relevance scoring failed for: ${title}`, cause));
    }
  }

  /**
   * Combined scoring: keyword first, LLM if borderline.
   *
   * If the keyword score falls in the borderline zone (0.3-0.7) and an LLM
   * scorer is provided, the LLM score is used instead.
   */
  async score(title: string, content: string, scorerFn?: RelevanceScorerFn): Promise<RelevanceResult> {
    const keywordResult = this.scoreKeywords(title, content);

    // If no LLM scorer or keyword score is decisive, return keyword result
    if (!scorerFn || keywordResult.score < BORDERLINE_LOW || keywordResult.score > BORDERLINE_HIGH) {
      return keywordResult;
    }

    // Borderline -- use LLM for more accurate scoring
    this.logger.debug("score", `Borderline keyword score (${keywordResult.score}), using LLM`, {
      title,
    });

    const llmResult = await this.scoreLlm(title, content, scorerFn);
    if (llmResult.ok) {
      return llmResult.value;
    }

    // LLM failed -- fall back to keyword score
    this.logger.warn("score", "LLM scoring failed, using keyword score", {
      title,
      keywordScore: keywordResult.score,
    });
    return keywordResult;
  }

  /** Check if content passes the minimum relevance threshold. */
  passesThreshold(result: RelevanceResult): boolean {
    return result.score >= this.config.minScore;
  }
}
