/**
 * Memory query step executor.
 *
 * Searches Eidolon's memory store for relevant context.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { MemorySearch } from "../../memory/search.ts";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { MemoryQueryConfigSchema } from "../types.ts";

export interface MemoryExecutorDeps {
  readonly memorySearch: MemorySearch;
}

export class MemoryStepExecutor implements IStepExecutor {
  readonly type = "memory_query" as const;

  constructor(private readonly deps: MemoryExecutorDeps) {}

  async execute(
    config: StepConfig,
    _context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = MemoryQueryConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid memory_query config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { query, limit } = parsed.data;

    try {
      const results = await this.deps.memorySearch.search({ text: query, limit: limit ?? 10 });
      if (!results.ok) {
        return Err(results.error);
      }

      const memories = results.value.map((m) => ({
        content: m.memory.content,
        score: m.score,
        type: m.memory.type,
      }));

      return Ok({ data: memories, tokensUsed: 0 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.MEMORY_EXTRACTION_FAILED, `Memory query failed: ${msg}`, err));
    }
  }
}
