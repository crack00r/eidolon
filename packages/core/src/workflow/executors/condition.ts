/**
 * Condition step executor and expression evaluator.
 *
 * Evaluates simple comparison expressions against the workflow context.
 * Supported operators: ==, !=, >, <, >=, <=, contains.
 * No JavaScript eval() -- only safe string-based comparisons.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { ConditionConfigSchema } from "../types.ts";

// ---------------------------------------------------------------------------
// Public: Condition evaluator (also used by engine for step conditions)
// ---------------------------------------------------------------------------

/**
 * Safely evaluate a simple condition expression against the workflow context.
 *
 * Format: "left operator right"
 * - left/right can be: stepId.output, trigger.field, a number, or a quoted string
 * - operators: ==, !=, >, <, >=, <=, contains
 *
 * Uses only string comparison -- no code execution.
 * Returns true/false. Returns false for unparseable expressions.
 */
export function evaluateCondition(expression: string, context: WorkflowContext): boolean {
  const trimmed = expression.trim();

  // Try compound expressions: split on || first (lower precedence),
  // then && (higher precedence) -- this gives standard operator precedence
  // since the first split binds loosest.
  if (trimmed.includes(" || ")) {
    return trimmed.split(" || ").some((part) => evaluateCondition(part.trim(), context));
  }
  if (trimmed.includes(" && ")) {
    return trimmed.split(" && ").every((part) => evaluateCondition(part.trim(), context));
  }

  // Parse single comparison: find the operator
  const operators = [">=", "<=", "!=", "==", ">", "<", "contains"] as const;
  for (const op of operators) {
    const pattern = ` ${op} `;
    const idx = trimmed.indexOf(pattern);
    if (idx === -1) continue;

    const left = resolveValue(trimmed.slice(0, idx).trim(), context);
    const right = resolveValue(trimmed.slice(idx + pattern.length).trim(), context);
    return compare(left, op, right);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Condition Step Executor
// ---------------------------------------------------------------------------

export class ConditionStepExecutor implements IStepExecutor {
  readonly type = "condition" as const;

  async execute(
    config: StepConfig,
    context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = ConditionConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid condition config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const result = evaluateCondition(parsed.data.expression, context);
    return Ok({ data: result, tokensUsed: 0 });
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function resolveValue(token: string, context: WorkflowContext): unknown {
  // Quoted string
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }

  // Number
  const num = Number(token);
  if (!Number.isNaN(num) && token !== "") {
    return num;
  }

  // Boolean
  if (token === "true") return true;
  if (token === "false") return false;

  // Dotted reference: stepId.output or trigger.field
  const dotIdx = token.indexOf(".");
  if (dotIdx > 0) {
    const prefix = token.slice(0, dotIdx);
    const suffix = token.slice(dotIdx + 1);

    if (prefix === "trigger") {
      const payload = context.triggerPayload;
      if (payload !== null && typeof payload === "object") {
        return (payload as Record<string, unknown>)[suffix];
      }
      return undefined;
    }

    if (suffix === "output") {
      return context.stepOutputs.get(prefix);
    }

    // Nested: stepId.field -> look up stepId output then get field
    const stepOutput = context.stepOutputs.get(prefix);
    if (stepOutput !== null && typeof stepOutput === "object") {
      return (stepOutput as Record<string, unknown>)[suffix];
    }
  }

  // Variable reference
  if (context.variables[token] !== undefined) {
    return context.variables[token];
  }

  return token;
}

function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
      return left === right || String(left) === String(right);
    case "!=":
      return left !== right && String(left) !== String(right);
    case ">":
      return Number(left) > Number(right);
    case "<":
      return Number(left) < Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "<=":
      return Number(left) <= Number(right);
    case "contains":
      return String(left).includes(String(right));
    default:
      return false;
  }
}
