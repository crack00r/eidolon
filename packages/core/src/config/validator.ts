/**
 * Validate raw configuration data against the Zod schema,
 * apply environment overrides, and resolve platform defaults.
 *
 * Extracted from loader.ts per the implementation plan (G-01).
 */

import type { EidolonConfig, EidolonError, Result } from "@eidolon/protocol";
import { createError, EidolonConfigSchema, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { resolveDefaults } from "./defaults.ts";
import { applyEnvOverrides } from "./env.ts";

/**
 * Validate raw config data against the EidolonConfigSchema.
 * Returns Err with CONFIG_INVALID if the data does not conform.
 *
 * This is a pure schema validation without env overrides or defaults.
 */
export function validateConfig(raw: unknown): Result<EidolonConfig, EidolonError> {
  const result = EidolonConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return Err(createError(ErrorCode.CONFIG_INVALID, `Config validation failed: ${issues}`));
  }
  return Ok(result.data);
}

/**
 * Validate raw config data and resolve defaults.
 * Can be used standalone without loading from file.
 *
 * Pipeline: Zod parse -> env overrides -> re-validate -> resolve defaults.
 */
export function validateAndResolve(raw: unknown): Result<EidolonConfig, EidolonError> {
  const result = EidolonConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return Err(createError(ErrorCode.CONFIG_INVALID, `Config validation failed: ${issues}`));
  }

  // Apply environment overrides
  const withEnv = applyEnvOverrides(result.data);

  // Re-validate after env overrides to ensure overridden values conform to the schema.
  // This prevents env vars from injecting values that bypass Zod type/constraint checks.
  const revalidated = EidolonConfigSchema.safeParse(withEnv);
  if (!revalidated.success) {
    const issues = revalidated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return Err(createError(ErrorCode.CONFIG_INVALID, `Config validation failed after env overrides: ${issues}`));
  }

  // Resolve platform-specific defaults
  const resolved = resolveDefaults(revalidated.data);

  return Ok(resolved);
}
