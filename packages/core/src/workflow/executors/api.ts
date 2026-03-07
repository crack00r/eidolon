/**
 * API call step executor.
 *
 * Makes HTTP requests to external APIs. Respects abort signals for cancellation.
 * Uses native fetch -- no shell commands.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { ApiCallConfigSchema } from "../types.ts";

export class ApiStepExecutor implements IStepExecutor {
  readonly type = "api_call" as const;

  async execute(
    config: StepConfig,
    _context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = ApiCallConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid api_call config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { url, method, headers, body } = parsed.data;

    try {
      const response = await fetch(url, {
        method,
        headers: headers ?? undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });

      const responseText = await response.text();
      let responseData: unknown;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      if (!response.ok) {
        return Err(
          createError(
            ErrorCode.CIRCUIT_OPEN,
            `API call failed with status ${response.status}: ${responseText.slice(0, 200)}`,
          ),
        );
      }

      return Ok({ data: responseData, tokensUsed: 0 });
    } catch (err: unknown) {
      if (signal.aborted) {
        return Err(createError(ErrorCode.TIMEOUT, "API call aborted"));
      }
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.CIRCUIT_OPEN, `API call failed: ${msg}`, err));
    }
  }
}
