/**
 * MCP Marketplace Discovery -- LLM-based matching of user intent to MCP servers.
 *
 * Given a user's natural language request (e.g., "I need Notion access"),
 * uses an IClaudeProcess to determine which MCP servers would satisfy it.
 */

import type { EidolonError, IClaudeProcess, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { listMcpTemplates, type McpTemplate } from "../templates.ts";
import { McpDiscoveryResponseSchema, type McpDiscoveryMatch } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCOVERY_SESSION_ID = "mcp-discovery";
const MAX_MATCHES = 5;

// ---------------------------------------------------------------------------
// McpDiscovery
// ---------------------------------------------------------------------------

export class McpDiscovery {
  private readonly claude: IClaudeProcess;
  private readonly logger: Logger;

  constructor(claude: IClaudeProcess, logger: Logger) {
    this.claude = claude;
    this.logger = logger.child("mcp-discovery");
  }

  /**
   * Match a user intent string against available MCP server templates.
   * Returns ranked matches with confidence scores.
   */
  async matchIntent(userIntent: string): Promise<Result<readonly McpDiscoveryMatch[], EidolonError>> {
    const templates = listMcpTemplates();
    const catalogSummary = this.buildCatalogSummary(templates);
    const prompt = this.buildPrompt(userIntent, catalogSummary);

    try {
      let output = "";

      for await (const event of this.claude.run(prompt, {
        sessionId: DISCOVERY_SESSION_ID,
        workspaceDir: process.cwd(),
        maxTurns: 1,
      })) {
        if (event.type === "text" && event.content) {
          output += event.content;
        }
      }

      const matches = this.parseResponse(output);
      if (!matches.ok) return matches;

      // Sort by confidence descending and limit
      const sorted = [...matches.value]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_MATCHES);

      this.logger.info("match", `Found ${String(sorted.length)} matches for intent: "${userIntent}"`);
      return Ok(sorted);
    } catch (cause) {
      return Err(
        createError(ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED, `MCP discovery failed for intent: "${userIntent}"`, cause),
      );
    }
  }

  /**
   * Simple keyword-based matching (no LLM required).
   * Useful as a fallback or for quick filtering.
   */
  matchKeywords(userIntent: string): readonly McpDiscoveryMatch[] {
    const lowerIntent = userIntent.toLowerCase();
    const templates = listMcpTemplates();
    const matches: McpDiscoveryMatch[] = [];

    for (const template of templates) {
      const score = this.computeKeywordScore(lowerIntent, template);
      if (score > 0) {
        matches.push({
          templateId: template.id,
          confidence: Math.min(score, 1),
          reasoning: `Matched by keywords: ${template.name} (${template.tags.join(", ")})`,
        });
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_MATCHES);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private buildCatalogSummary(templates: readonly McpTemplate[]): string {
    return templates
      .map((t) => `- ID: ${t.id} | Name: ${t.name} | Description: ${t.description} | Tags: ${t.tags.join(", ")}`)
      .join("\n");
  }

  private buildPrompt(userIntent: string, catalog: string): string {
    return `You are an MCP (Model Context Protocol) server recommendation engine.

Given the user's intent and the available MCP server catalog, determine which servers would best satisfy the user's needs.

## Available MCP Servers
${catalog}

## User Intent
"${userIntent}"

## Instructions
Respond with ONLY a JSON object in this exact format:
{
  "matches": [
    {
      "templateId": "<server-id>",
      "confidence": <0.0-1.0>,
      "reasoning": "<brief explanation>"
    }
  ]
}

Only include servers with confidence >= 0.3. Maximum 5 matches.
If no servers match, return {"matches": []}.
Respond with ONLY the JSON, no other text.`;
  }

  private parseResponse(output: string): Result<readonly McpDiscoveryMatch[], EidolonError> {
    // Extract JSON from the response (may be wrapped in markdown code blocks)
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return Err(
        createError(ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED, `No JSON found in discovery response: ${output.slice(0, 200)}`),
      );
    }

    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      const validated = McpDiscoveryResponseSchema.safeParse(parsed);

      if (!validated.success) {
        return Err(
          createError(
            ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED,
            `Invalid discovery response format: ${validated.error.message}`,
          ),
        );
      }

      // Filter to only known template IDs
      const knownIds = new Set(listMcpTemplates().map((t) => t.id));
      const validMatches = validated.data.matches.filter((m) => knownIds.has(m.templateId));

      return Ok(validMatches);
    } catch (cause) {
      return Err(
        createError(ErrorCode.STRUCTURED_OUTPUT_PARSE_FAILED, "Failed to parse discovery JSON response", cause),
      );
    }
  }

  private computeKeywordScore(lowerIntent: string, template: McpTemplate): number {
    let score = 0;
    const words = lowerIntent.split(/\s+/);

    // Check template name
    if (lowerIntent.includes(template.name.toLowerCase())) {
      score += 0.6;
    }

    // Check template ID
    if (lowerIntent.includes(template.id.toLowerCase())) {
      score += 0.5;
    }

    // Check tags
    for (const tag of template.tags) {
      if (lowerIntent.includes(tag.toLowerCase())) {
        score += 0.3;
      }
    }

    // Check description words
    const descWords = template.description.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 3 && descWords.includes(word)) {
        score += 0.1;
      }
    }

    return score;
  }
}
