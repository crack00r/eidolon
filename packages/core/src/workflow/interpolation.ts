/**
 * Variable interpolation for workflow step configs.
 *
 * Resolves {{stepId.output}} placeholders from the WorkflowContext.
 * Handles missing variables gracefully by leaving them as empty strings.
 */

import type { WorkflowContext } from "./types.ts";

const PLACEHOLDER_REGEX = /\{\{(\w+)\.output\}\}/g;

/**
 * Interpolate all {{stepId.output}} references in a template string.
 * Missing step outputs are replaced with an empty string.
 */
export function interpolate(template: string, context: WorkflowContext): string {
  return template.replace(PLACEHOLDER_REGEX, (_, stepId: string) => {
    const value = context.stepOutputs.get(stepId);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/**
 * Deeply interpolate all string values in a config object.
 * Returns a new object with all string values interpolated.
 */
export function interpolateConfig(config: Record<string, unknown>, context: WorkflowContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      result[key] = interpolate(value, context);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => (typeof item === "string" ? interpolate(item, context) : item));
    } else if (value !== null && typeof value === "object") {
      result[key] = interpolateConfig(value as Record<string, unknown>, context);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract all step IDs referenced in a template string.
 * Useful for validation -- ensure referenced steps exist.
 */
export function extractReferences(template: string): readonly string[] {
  const refs: string[] = [];
  const regex = new RegExp(PLACEHOLDER_REGEX.source, "g");
  for (const match of template.matchAll(regex)) {
    const stepId = match[1];
    if (stepId && !refs.includes(stepId)) {
      refs.push(stepId);
    }
  }
  return refs;
}
