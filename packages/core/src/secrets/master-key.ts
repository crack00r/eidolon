/**
 * Master key management for the secret store.
 *
 * In production, set EIDOLON_MASTER_KEY as an environment variable.
 * The value should be a hex-encoded 256-bit key (64 hex chars).
 * Shorter values (passphrases) are hashed with SHA-256 to produce a 32-byte key.
 */

import { createHash, randomBytes } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

const ENV_KEY = "EIDOLON_MASTER_KEY";

/**
 * Get the master key from the EIDOLON_MASTER_KEY environment variable.
 *
 * - If the value is exactly 64 hex characters, it is decoded directly as a 32-byte key.
 * - Otherwise, the value is treated as a passphrase and hashed with SHA-256.
 */
export function getMasterKey(): Result<Buffer, EidolonError> {
  const envValue = process.env[ENV_KEY];
  if (!envValue) {
    return Err(createError(ErrorCode.MASTER_KEY_MISSING, `Master key not set. Set ${ENV_KEY} environment variable.`));
  }

  // If it looks like hex (64 chars), decode directly
  if (/^[0-9a-fA-F]{64}$/.test(envValue)) {
    return Ok(Buffer.from(envValue, "hex"));
  }

  // Otherwise, hash the passphrase to get a 32-byte key
  const key = createHash("sha256").update(envValue).digest();
  return Ok(key);
}

/**
 * Generate a new random master key (for initial setup).
 * Returns a hex-encoded 256-bit (32 bytes = 64 hex chars) key.
 */
export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}
