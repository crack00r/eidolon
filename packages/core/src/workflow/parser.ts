/**
 * WorkflowParser -- converts natural language descriptions into
 * structured WorkflowDefinition objects using Claude.
 *
 * Uses IClaudeProcess with a structured output prompt.
 * The parsed result should be confirmed by the user before execution.
 */

import { randomUUID } from "node:crypto";
import type { ClaudeSessionOptions, EidolonError, IClaudeProcess, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { WorkflowDefinition } from "./types.ts";
import { WorkflowDefinitionSchema } from "./types.ts";

const SYSTEM_PROMPT = `You are a workflow parser. Convert the user's natural language description into a structured workflow definition JSON.

RULES:
- Output ONLY valid JSON, no markdown fences, no explanation.
- Use the exact schema structure provided.
- Each step must have a unique "id" (use short descriptive snake_case names).
- Set "dependsOn" to empty array for first steps, or list IDs of steps that must complete first.
- For step type "llm_call", the config must include "prompt" and "outputKey".
- For step type "channel_send", the config must include "channelId" and "message".
- For step type "api_call", the config must include "url", "method", and "outputKey".
- For step type "condition", the config must include "expression", "thenSteps", and "elseSteps".
- For step type "ha_command", the config must include "entityId" and "action".
- Use {{stepId.output}} syntax to reference outputs of previous steps.
- Default trigger is "manual" unless the user specifies otherwise.
- Default onFailure is {"type":"notify","channel":"telegram"}.

OUTPUT SCHEMA:
{
  "id": "wf-<uuid>",
  "name": "short descriptive name",
  "description": "brief description",
  "trigger": { "type": "manual" },
  "steps": [
    {
      "id": "step_name",
      "name": "Human readable name",
      "type": "llm_call|api_call|channel_send|wait|condition|transform|ha_command|memory_query",
      "config": { ... },
      "dependsOn": []
    }
  ],
  "onFailure": { "type": "notify", "channel": "telegram" },
  "createdAt": <timestamp>,
  "createdBy": "user",
  "maxDurationMs": 1800000,
  "metadata": {}
}`;

export class WorkflowParser {
  constructor(
    private readonly claudeProcess: IClaudeProcess,
    private readonly workspaceDir: string,
    private readonly logger: Logger,
  ) {}

  async parse(naturalLanguage: string): Promise<Result<WorkflowDefinition, EidolonError>> {
    const prompt = `Parse this workflow description into the JSON format:\n\n"${naturalLanguage}"`;
    const options: ClaudeSessionOptions = {
      workspaceDir: this.workspaceDir,
      systemPrompt: SYSTEM_PROMPT,
    };

    try {
      let responseText = "";

      for await (const event of this.claudeProcess.run(prompt, options)) {
        if (event.type === "text" && event.content) {
          responseText += event.content;
        }
        if (event.type === "error") {
          return Err(createError(ErrorCode.LLM_RESPONSE_INVALID, `Parse error: ${event.error ?? "unknown"}`));
        }
      }

      // Strip any markdown fences
      responseText = responseText.trim();
      if (responseText.startsWith("```")) {
        const firstNewline = responseText.indexOf("\n");
        const lastFence = responseText.lastIndexOf("```");
        if (firstNewline > 0 && lastFence > firstNewline) {
          responseText = responseText.slice(firstNewline + 1, lastFence).trim();
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        return Err(createError(ErrorCode.LLM_RESPONSE_INVALID, "Failed to parse LLM response as JSON"));
      }

      // Inject an ID and timestamp if missing
      const withDefaults = {
        ...(parsed as Record<string, unknown>),
        id: (parsed as Record<string, unknown>).id ?? `wf-${randomUUID().slice(0, 8)}`,
        createdAt: (parsed as Record<string, unknown>).createdAt ?? Date.now(),
      };

      const validated = WorkflowDefinitionSchema.safeParse(withDefaults);
      if (!validated.success) {
        this.logger.warn("workflow-parser", `Validation failed: ${validated.error.message}`, {
          raw: responseText.slice(0, 500),
        });
        return Err(
          createError(ErrorCode.LLM_RESPONSE_INVALID, `Invalid workflow structure: ${validated.error.message}`),
        );
      }

      return Ok(validated.data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.CLAUDE_PROCESS_CRASHED, `Workflow parsing failed: ${msg}`, err));
    }
  }
}
