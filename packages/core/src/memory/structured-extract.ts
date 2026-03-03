/**
 * Structured extraction -- factory for LlmExtractFn backed by StructuredOutputParser.
 *
 * Creates a production-ready LLM extraction function that uses a Zod schema
 * to constrain and validate Claude's memory extraction output. Plugs into
 * MemoryExtractor via the existing `llmExtractFn` injection point.
 */

import type { ClaudeSessionOptions, IClaudeProcess } from "@eidolon/protocol";
import { z } from "zod";
import { StructuredOutputParser } from "../claude/structured-output.ts";
import type { Logger } from "../logging/logger.ts";
import type { ConversationTurn, ExtractedMemory, LlmExtractFn } from "./extractor.ts";

// ---------------------------------------------------------------------------
// Schema for structured extraction output
// ---------------------------------------------------------------------------

/** Valid memory types that the LLM can output. */
const MEMORY_TYPE_ENUM = z.enum(["fact", "preference", "decision", "episode", "skill", "relationship", "schema"]);

/** Schema for a single extracted memory from the LLM. */
const ExtractedMemorySchema = z.object({
  type: MEMORY_TYPE_ENUM,
  content: z.string().min(1).max(10_000),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
});

/** Schema for the full extraction response. */
export const ExtractionResponseSchema = z.object({
  memories: z.array(ExtractedMemorySchema),
});

export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

/**
 * Build the extraction prompt for a conversation turn.
 *
 * The system prompt with schema instructions is added by the StructuredOutputParser;
 * this function only builds the user-facing prompt that describes the task.
 */
function buildExtractionPrompt(turn: ConversationTurn): string {
  return [
    "Analyze this conversation turn and extract structured memories.",
    "",
    "USER MESSAGE:",
    turn.userMessage,
    "",
    "ASSISTANT RESPONSE:",
    turn.assistantResponse,
    "",
    "Rules:",
    "- Only extract CLEAR, EXPLICIT information. Do not infer or speculate.",
    "- Return empty memories array if nothing notable was said.",
    "- Each memory must have a confidence between 0.0 and 1.0.",
    '- Use type "fact" for discrete knowledge, "preference" for user preferences,',
    '  "decision" for choices made, "episode" for interaction summaries,',
    '  "skill" for learned procedures, "relationship" for entity connections.',
    "- Tags should categorize the memory (e.g., 'personal', 'technology', 'project').",
    "- Content should be a concise, self-contained statement.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

/** Configuration for the structured extraction function. */
export interface StructuredExtractOptions {
  /** Claude session options (workspaceDir is required). */
  readonly sessionOptions: ClaudeSessionOptions;
  /** System prompt prefix for extraction context. */
  readonly systemPrompt?: string;
  /** Max retries on validation failure (default: 2). */
  readonly maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an LlmExtractFn backed by StructuredOutputParser.
 *
 * Returns a function compatible with MemoryExtractor's `llmExtractFn` option.
 * The function sends a conversation turn to Claude, validates the response
 * against the ExtractionResponseSchema, and returns ExtractedMemory[].
 *
 * Usage:
 * ```typescript
 * const extractFn = createStructuredLlmExtractFn(claudeProcess, logger, {
 *   sessionOptions: { workspaceDir: "/tmp/workspace" },
 * });
 * const extractor = new MemoryExtractor(logger, {
 *   strategy: "hybrid",
 *   llmExtractFn: extractFn,
 * });
 * ```
 */
export function createStructuredLlmExtractFn(
  claude: IClaudeProcess,
  logger: Logger,
  options: StructuredExtractOptions,
): LlmExtractFn {
  const parser = new StructuredOutputParser(ExtractionResponseSchema, claude, logger, {
    maxRetries: options.maxRetries ?? 2,
  });

  const baseSystemPrompt = options.systemPrompt ?? "You are a memory extraction assistant.";

  return async (turn: ConversationTurn): Promise<ExtractedMemory[]> => {
    const prompt = buildExtractionPrompt(turn);

    const sessionOptions: ClaudeSessionOptions = {
      ...options.sessionOptions,
      systemPrompt: baseSystemPrompt,
      outputSchema: ExtractionResponseSchema,
    };

    const result = await parser.parse(prompt, sessionOptions);

    if (!result.ok) {
      logger.warn("structured-extract", "Structured extraction failed", {
        error: result.error.message,
      });
      throw new Error(`Structured extraction failed: ${result.error.message}`);
    }

    // Convert validated response to ExtractedMemory[] format
    return result.value.memories.map(
      (mem): ExtractedMemory => ({
        type: mem.type,
        content: mem.content,
        confidence: mem.confidence,
        tags: mem.tags,
        source: "llm",
        sensitive: false, // PII screening is done by MemoryExtractor after extraction
      }),
    );
  };
}
