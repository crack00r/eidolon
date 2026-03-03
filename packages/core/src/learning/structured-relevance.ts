/**
 * Structured relevance scoring -- factory for RelevanceScorerFn backed by StructuredOutputParser.
 *
 * Creates a production-ready LLM relevance scoring function that uses a Zod schema
 * to constrain and validate Claude's relevance assessment. Plugs into
 * RelevanceFilter via the existing `RelevanceScorerFn` injection point.
 */

import { z } from "zod";
import type { ClaudeSessionOptions, IClaudeProcess } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { StructuredOutputParser } from "../claude/structured-output.ts";
import type { RelevanceResult, RelevanceScorerFn } from "./relevance.ts";

// ---------------------------------------------------------------------------
// Schema for structured relevance scoring output
// ---------------------------------------------------------------------------

/** Schema for the relevance scoring response from the LLM. */
export const RelevanceResponseSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string().min(1),
  matchedInterests: z.array(z.string()),
});

export type RelevanceResponse = z.infer<typeof RelevanceResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

/**
 * Build the relevance scoring prompt.
 *
 * The system prompt with schema instructions is added by the StructuredOutputParser;
 * this function only builds the user-facing prompt that describes the task.
 */
function buildRelevancePrompt(
  title: string,
  content: string,
  interests: readonly string[],
): string {
  const interestList = interests.length > 0
    ? interests.map((i) => `  - ${i}`).join("\n")
    : "  (no specific interests configured)";

  return [
    "Evaluate the relevance of this content against the user's interests.",
    "",
    `TITLE: ${title}`,
    "",
    "CONTENT:",
    content.slice(0, 4000), // Limit content length to control token usage
    "",
    "USER INTERESTS:",
    interestList,
    "",
    "SYSTEM INTERESTS (always relevant):",
    "  - Self-hosted AI/ML tools and techniques",
    "  - Personal assistant improvements",
    "  - Home automation and network management",
    "  - TypeScript/Python libraries and tools",
    "  - Security best practices",
    "",
    "Scoring guidelines:",
    "- Score 0.0-0.3: Not relevant to any interest",
    "- Score 0.3-0.6: Tangentially related",
    "- Score 0.6-0.8: Directly relevant to one or more interests",
    "- Score 0.8-1.0: Highly relevant, actionable for the user",
    "- matchedInterests: list only interests that actually match the content",
    "- reason: brief explanation of why this score was given",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

/** Configuration for the structured relevance scoring function. */
export interface StructuredRelevanceOptions {
  /** Claude session options (workspaceDir is required). */
  readonly sessionOptions: ClaudeSessionOptions;
  /** System prompt prefix for relevance context. */
  readonly systemPrompt?: string;
  /** Max retries on validation failure (default: 2). */
  readonly maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a RelevanceScorerFn backed by StructuredOutputParser.
 *
 * Returns a function compatible with RelevanceFilter's `scorerFn` parameter.
 * The function sends content to Claude for relevance assessment, validates
 * the response against the RelevanceResponseSchema, and returns a RelevanceResult.
 *
 * Usage:
 * ```typescript
 * const scorerFn = createStructuredRelevanceScorerFn(claudeProcess, logger, {
 *   sessionOptions: { workspaceDir: "/tmp/workspace" },
 * });
 * const filter = new RelevanceFilter(config, logger);
 * const result = await filter.score(title, content, scorerFn);
 * ```
 */
export function createStructuredRelevanceScorerFn(
  claude: IClaudeProcess,
  logger: Logger,
  options: StructuredRelevanceOptions,
): RelevanceScorerFn {
  const parser = new StructuredOutputParser(
    RelevanceResponseSchema,
    claude,
    logger,
    { maxRetries: options.maxRetries ?? 2 },
  );

  const baseSystemPrompt = options.systemPrompt
    ?? "You are a content relevance evaluator for a personal AI assistant.";

  return async (
    title: string,
    content: string,
    interests: readonly string[],
  ): Promise<RelevanceResult> => {
    const prompt = buildRelevancePrompt(title, content, interests);

    const sessionOptions: ClaudeSessionOptions = {
      ...options.sessionOptions,
      systemPrompt: baseSystemPrompt,
      outputSchema: RelevanceResponseSchema,
    };

    const result = await parser.parse(prompt, sessionOptions);

    if (!result.ok) {
      logger.warn("structured-relevance", "Structured relevance scoring failed", {
        error: result.error.message,
        title,
      });
      throw new Error(`Structured relevance scoring failed: ${result.error.message}`);
    }

    return {
      score: result.value.score,
      reason: result.value.reason,
      matchedInterests: result.value.matchedInterests,
    };
  };
}
