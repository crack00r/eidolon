/**
 * Transform step executor.
 *
 * Performs basic data transformations on workflow step outputs.
 * Supports: uppercase, lowercase, trim, slice, json_extract, stringify, length.
 * No arbitrary code execution.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { interpolate } from "../interpolation.ts";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { TransformConfigSchema } from "../types.ts";

export class TransformStepExecutor implements IStepExecutor {
  readonly type = "transform" as const;

  async execute(
    config: StepConfig,
    context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = TransformConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid transform config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { input, expression } = parsed.data;

    // Resolve the input value
    const inputValue = interpolate(input, context);

    try {
      const result = applyTransform(inputValue, expression);
      return Ok({ data: result, tokensUsed: 0 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.CONFIG_INVALID, `Transform failed: ${msg}`, err));
    }
  }
}

function applyTransform(input: string, expression: string): unknown {
  const parts = expression.split("|").map((p) => p.trim());
  let current: unknown = input;

  for (const part of parts) {
    current = applySingleTransform(current, part);
  }

  return current;
}

function applySingleTransform(input: unknown, expr: string): unknown {
  const str = typeof input === "string" ? input : JSON.stringify(input ?? "");

  if (expr === "uppercase") return str.toUpperCase();
  if (expr === "lowercase") return str.toLowerCase();
  if (expr === "trim") return str.trim();
  if (expr === "length") return str.length;
  if (expr === "stringify") return JSON.stringify(input);
  if (expr === "parse_json") {
    try {
      return JSON.parse(str) as unknown;
    } catch {
      return str;
    }
  }

  // slice:start:end
  if (expr.startsWith("slice:")) {
    const sliceParts = expr.split(":");
    const start = Number(sliceParts[1] ?? 0);
    const end = sliceParts[2] ? Number(sliceParts[2]) : undefined;
    return str.slice(start, end);
  }

  // json_extract:.field.path
  if (expr.startsWith("json_extract:")) {
    const path = expr.slice("json_extract:".length);
    let obj: unknown;
    try {
      obj = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
      return input;
    }
    return extractJsonPath(obj, path);
  }

  // If no recognized transform, return input unchanged
  return input;
}

function extractJsonPath(obj: unknown, path: string): unknown {
  const keys = path.split(".").filter((k) => k.length > 0);
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
