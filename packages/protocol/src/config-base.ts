/**
 * Base configuration primitives shared across all config sub-modules.
 * This file has no internal imports to prevent circular dependencies.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Secret Reference
// ---------------------------------------------------------------------------

export const SecretRefSchema = z.object({ $secret: z.string() });
export type SecretRef = z.infer<typeof SecretRefSchema>;

/** Accepts either a plain string or a { $secret: "KEY_NAME" } reference. */
export function stringOrSecret(): z.ZodUnion<[z.ZodString, typeof SecretRefSchema]> {
  return z.union([z.string().min(1), SecretRefSchema]);
}
