/**
 * StructuredOutputParser -- constrains Claude Code responses to match a Zod schema.
 *
 * Strategy:
 * 1. Generate a system prompt suffix describing the required JSON structure
 * 2. Collect the full text response from Claude's stream events
 * 3. Extract JSON from the response (handles markdown code fences)
 * 4. Validate with Zod schema
 * 5. On validation failure, retry with error correction prompt (up to maxRetries)
 *
 * Returns Result<T, EidolonError> where T is the inferred Zod type.
 */

import type { z } from "zod";
import type { EidolonError, IClaudeProcess, ClaudeSessionOptions, StreamEvent, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

/** Configuration for the structured output parser. */
export interface StructuredOutputConfig {
  /** Maximum number of retry attempts on validation failure (default: 2). */
  readonly maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 2;

/**
 * Generate a JSON schema description from a Zod schema for inclusion in prompts.
 *
 * Uses zod-to-json-schema-like approach: we describe the shape textually.
 * For complex schemas, we rely on Zod's built-in description and shape introspection.
 */
export function generateSchemaInstruction(schema: z.ZodType): string {
  const jsonSchema = zodToJsonDescription(schema);
  return [
    "You MUST respond with ONLY valid JSON matching this exact schema.",
    "Do NOT include any text, explanation, or markdown formatting outside the JSON.",
    "Do NOT wrap the JSON in code fences.",
    "",
    "Required JSON schema:",
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
  ].join("\n");
}

/**
 * Convert a Zod schema to a JSON-schema-like description object.
 *
 * This produces a plain object that describes the schema shape in a way
 * that an LLM can understand. It is NOT a full JSON Schema implementation --
 * just enough to communicate the expected structure.
 */
export function zodToJsonDescription(schema: z.ZodType): Record<string, unknown> {
  const def = schema._def as Record<string, unknown>;
  const typeName = def.typeName as string | undefined;

  switch (typeName) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodType>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, valueSchema] of Object.entries(shape)) {
        properties[key] = zodToJsonDescription(valueSchema);
        const valueDef = (valueSchema as z.ZodType)._def as Record<string, unknown>;
        if (valueDef.typeName !== "ZodOptional") {
          required.push(key);
        }
      }

      return { type: "object", properties, required };
    }

    case "ZodArray": {
      const innerType = def.type as z.ZodType;
      return { type: "array", items: zodToJsonDescription(innerType) };
    }

    case "ZodString":
      return { type: "string" };

    case "ZodNumber":
      return { type: "number" };

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodEnum": {
      const values = def.values as readonly string[];
      return { type: "string", enum: [...values] };
    }

    case "ZodOptional": {
      const innerType = def.innerType as z.ZodType;
      return { ...zodToJsonDescription(innerType), optional: true };
    }

    case "ZodNullable": {
      const innerType = def.innerType as z.ZodType;
      return { ...zodToJsonDescription(innerType), nullable: true };
    }

    case "ZodDefault": {
      const innerType = def.innerType as z.ZodType;
      return zodToJsonDescription(innerType);
    }

    case "ZodLiteral": {
      const value = def.value;
      return { type: typeof value, const: value };
    }

    case "ZodUnion": {
      const options = def.options as z.ZodType[];
      return { oneOf: options.map(zodToJsonDescription) };
    }

    case "ZodRecord": {
      const valueType = def.valueType as z.ZodType;
      return { type: "object", additionalProperties: zodToJsonDescription(valueType) };
    }

    case "ZodTuple": {
      const items = def.items as z.ZodType[];
      return { type: "array", items: items.map(zodToJsonDescription) };
    }

    default:
      return { type: "unknown" };
  }
}

/**
 * Extract JSON from a Claude response string.
 *
 * Handles multiple formats:
 * 1. Pure JSON (response is just JSON)
 * 2. JSON wrapped in markdown code fences
 * 3. JSON embedded in surrounding text
 */
export function extractJson(response: string): string | null {
  const trimmed = response.trim();

  // Try 1: Pure JSON (starts with { or [)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  // Try 2: Extract from markdown code fence
  const codeFenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(trimmed);
  if (codeFenceMatch?.[1]) {
    return codeFenceMatch[1].trim();
  }

  // Try 3: Find first { or [ and match to closing brace/bracket
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");

  let startIdx: number;
  let openChar: string;
  let closeChar: string;

  if (firstBrace === -1 && firstBracket === -1) {
    return null;
  }
  if (firstBrace === -1) {
    startIdx = firstBracket;
    openChar = "[";
    closeChar = "]";
  } else if (firstBracket === -1) {
    startIdx = firstBrace;
    openChar = "{";
    closeChar = "}";
  } else if (firstBrace < firstBracket) {
    startIdx = firstBrace;
    openChar = "{";
    closeChar = "}";
  } else {
    startIdx = firstBracket;
    openChar = "[";
    closeChar = "]";
  }

  // Walk forward to find matching close
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIdx; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return trimmed.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * Collect all text content from a stream of Claude events.
 */
export async function collectTextFromStream(stream: AsyncIterable<StreamEvent>): Promise<string> {
  const parts: string[] = [];
  for await (const event of stream) {
    if (event.type === "text" && event.content) {
      parts.push(event.content);
    }
  }
  return parts.join("");
}

/**
 * Build a correction prompt after a validation failure.
 */
function buildCorrectionPrompt(originalPrompt: string, errorMessage: string): string {
  return [
    "Your previous response did not match the required JSON schema.",
    "",
    `Validation error: ${errorMessage}`,
    "",
    "Please correct your response and output ONLY valid JSON matching the schema.",
    "Do NOT include any explanation or markdown formatting.",
    "",
    `Original request: ${originalPrompt}`,
  ].join("\n");
}

/**
 * StructuredOutputParser -- validates Claude responses against a Zod schema.
 *
 * Usage:
 * ```typescript
 * const parser = new StructuredOutputParser(schema, claudeProcess, logger);
 * const result = await parser.parse("Extract facts from: ...", options);
 * if (result.ok) {
 *   // result.value is typed as z.infer<typeof schema>
 * }
 * ```
 */
export class StructuredOutputParser<T extends z.ZodType> {
  private readonly schema: T;
  private readonly claude: IClaudeProcess;
  private readonly logger: Logger;
  private readonly maxRetries: number;

  constructor(
    schema: T,
    claude: IClaudeProcess,
    logger: Logger,
    config?: StructuredOutputConfig,
  ) {
    this.schema = schema;
    this.claude = claude;
    this.logger = logger.child("structured-output");
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Send a prompt to Claude and parse the response against the schema.
   *
   * Appends schema instructions to the system prompt. On validation failure,
   * retries with an error correction prompt up to maxRetries times.
   *
   * Returns Result<z.infer<T>, EidolonError>.
   */
  async parse(
    prompt: string,
    options: ClaudeSessionOptions,
  ): Promise<Result<z.infer<T>, EidolonError>> {
    const schemaInstruction = generateSchemaInstruction(this.schema);
    const augmentedSystemPrompt = options.systemPrompt
      ? `${options.systemPrompt}\n\n${schemaInstruction}`
      : schemaInstruction;

    const augmentedOptions: ClaudeSessionOptions = {
      ...options,
      systemPrompt: augmentedSystemPrompt,
    };

    // First attempt
    const firstResult = await this.attemptParse(prompt, augmentedOptions);
    if (firstResult.ok) {
      return firstResult;
    }

    // Retry loop
    let lastError = firstResult.error;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      this.logger.warn("parse", `Validation failed, retry ${attempt}/${this.maxRetries}`, {
        error: lastError.message,
      });

      const correctionPrompt = buildCorrectionPrompt(prompt, lastError.message);
      const retryResult = await this.attemptParse(correctionPrompt, augmentedOptions);
      if (retryResult.ok) {
        this.logger.info("parse", `Validation succeeded on retry ${attempt}`);
        return retryResult;
      }
      lastError = retryResult.error;
    }

    this.logger.error("parse", `All ${this.maxRetries} retries exhausted`, {
      error: lastError.message,
    });

    return Err(
      createError(
        ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED,
        `Structured output validation failed after ${this.maxRetries} retries: ${lastError.message}`,
        lastError,
      ),
    );
  }

  /**
   * Parse a pre-collected response string against the schema without calling Claude.
   * Useful when you already have the response text and just want validation.
   */
  parseResponse(response: string): Result<z.infer<T>, EidolonError> {
    const jsonStr = extractJson(response);
    if (jsonStr === null) {
      return Err(
        createError(
          ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED,
          "No valid JSON found in response",
        ),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (cause) {
      return Err(
        createError(
          ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED,
          `JSON parse error: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        ),
      );
    }

    const validation = this.schema.safeParse(parsed);
    if (!validation.success) {
      const errorMessage = validation.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return Err(
        createError(
          ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED,
          `Schema validation failed: ${errorMessage}`,
        ),
      );
    }

    return Ok(validation.data as z.infer<T>);
  }

  /** Single attempt: run Claude and parse the response. */
  private async attemptParse(
    prompt: string,
    options: ClaudeSessionOptions,
  ): Promise<Result<z.infer<T>, EidolonError>> {
    try {
      const stream = this.claude.run(prompt, options);
      const responseText = await collectTextFromStream(stream);

      if (!responseText.trim()) {
        return Err(
          createError(
            ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED,
            "Claude returned an empty response",
          ),
        );
      }

      return this.parseResponse(responseText);
    } catch (cause) {
      return Err(
        createError(
          ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED,
          `Claude invocation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        ),
      );
    }
  }
}
