/**
 * Router-based relevance scoring -- uses IModelRouter to score content relevance.
 *
 * Unlike the structured-relevance.ts which uses IClaudeProcess (Claude Code CLI),
 * this scorer uses the IModelRouter to select the best available LLM provider
 * (ollama, llamacpp, or claude) and calls ILLMProvider.complete() directly.
 *
 * This is the preferred approach for production use, as it supports local LLM
 * providers and follows the task-based routing configuration.
 */

import { randomUUID } from "node:crypto";
import type { IModelRouter, LLMCompletionOptions } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import type { RelevanceResult, RelevanceScorerFn } from "./relevance.ts";

// ---------------------------------------------------------------------------
// Response schema (reused from structured-relevance for consistency)
// ---------------------------------------------------------------------------

const RouterRelevanceResponseSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string().min(1),
  matchedInterests: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Escape < and > in untrusted text to prevent delimiter injection.
 */
function escapeDelimiters(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildPrompt(title: string, content: string, interests: readonly string[]): string {
  const interestList =
    interests.length > 0 ? interests.map((i) => `  - ${i}`).join("\n") : "  (no specific interests configured)";

  // Use random boundaries and escape delimiters to mitigate prompt injection
  const boundary = `---BOUNDARY-${randomUUID()}---`;
  const safeTitle = escapeDelimiters(title);
  const safeContent = escapeDelimiters(content.slice(0, 4000));

  return [
    "Evaluate the relevance of this content against the user's interests.",
    "Respond ONLY with a JSON object, no other text.",
    "",
    boundary,
    `TITLE: ${safeTitle}`,
    boundary,
    "",
    boundary,
    "CONTENT:",
    safeContent,
    boundary,
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
    "",
    "Respond with this exact JSON format:",
    '{"score": <number 0-1>, "reason": "<brief explanation>", "matchedInterests": ["<interest1>", ...]}',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface RouterRelevanceOptions {
  /** LLM completion options override (model, temperature, etc). */
  readonly completionOptions?: LLMCompletionOptions;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a RelevanceScorerFn backed by IModelRouter.
 *
 * Routes the relevance scoring task to the best available provider
 * using the "filtering" task type. Falls back through the provider chain
 * (ollama -> llamacpp -> claude) based on availability.
 *
 * Usage:
 * ```typescript
 * const scorerFn = createRouterRelevanceScorerFn(router, logger);
 * const filter = new RelevanceFilter(config, logger);
 * const result = await filter.score(title, content, scorerFn);
 * ```
 */
export function createRouterRelevanceScorerFn(
  router: IModelRouter,
  logger: Logger,
  options?: RouterRelevanceOptions,
): RelevanceScorerFn {
  const childLogger = logger.child("router-relevance");

  return async (title: string, content: string, interests: readonly string[]): Promise<RelevanceResult> => {
    const provider = await router.selectProvider({ type: "filtering" });
    if (!provider) {
      throw new Error("No LLM provider available for relevance scoring (task type: filtering)");
    }

    childLogger.debug("score", `Using provider: ${provider.type} (${provider.name})`, { title });

    const prompt = buildPrompt(title, content, interests);

    const completionOptions: LLMCompletionOptions = {
      temperature: 0.1,
      maxTokens: 500,
      systemPrompt: "You are a content relevance evaluator. Respond ONLY with valid JSON.",
      ...options?.completionOptions,
    };

    const result = await provider.complete([{ role: "user", content: prompt }], completionOptions);

    // Parse JSON from the response content
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      childLogger.warn("score", "Provider returned no JSON in response", {
        title,
        provider: provider.type,
        content: result.content.slice(0, 200),
      });
      throw new Error(`LLM provider (${provider.type}) returned no JSON for relevance scoring`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error(`LLM provider (${provider.type}) returned invalid JSON for relevance scoring`);
    }

    const validated = RouterRelevanceResponseSchema.safeParse(parsed);
    if (!validated.success) {
      childLogger.warn("score", "Provider returned invalid relevance response", {
        title,
        provider: provider.type,
        errors: validated.error.issues.map((i) => i.message).join(", "),
      });
      throw new Error(
        `LLM provider (${provider.type}) returned invalid relevance response: ${validated.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const clamped = Math.max(0, Math.min(1, validated.data.score));

    childLogger.debug("score", `Scored: ${clamped}`, {
      title,
      provider: provider.type,
      reason: validated.data.reason,
    });

    return {
      score: clamped,
      reason: validated.data.reason,
      matchedInterests: validated.data.matchedInterests,
    };
  };
}
