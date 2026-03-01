/**
 * Master key management for the secret store.
 *
 * In production, set EIDOLON_MASTER_KEY as an environment variable.
 * The value should be a hex-encoded 256-bit key (64 hex chars).
 * Shorter values (passphrases) are hashed with SHA-256 to produce a 32-byte key.
 */

import { randomBytes, scryptSync } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

const ENV_KEY = "EIDOLON_MASTER_KEY";

/**
 * Zero out a Buffer to remove key material from memory.
 * Best-effort in JavaScript — the GC may have already copied the data,
 * but this eliminates the primary reference.
 */
export function zeroBuffer(buf: Buffer | Uint8Array): void {
  buf.fill(0);
}

/**
 * Get the master key from the EIDOLON_MASTER_KEY environment variable.
 *
 * - If the value is exactly 64 hex characters, it is decoded directly as a 32-byte key.
 * - Otherwise, the value is treated as a passphrase and derived via scrypt KDF.
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

  // Derive key from passphrase via scrypt KDF (with fixed application salt).
  // Using scrypt because Bun doesn't natively support argon2id. Parameters
  // (N=2^17, r=8, p=1) provide an equivalent security margin to argon2id with
  // recommended settings. If Bun gains argon2id support in the future, this
  // should be migrated. See SEC-SUPPLY-022.
  const PASSPHRASE_SALT = Buffer.from("eidolon-master-key-v1", "utf-8");
  const key = scryptSync(envValue, PASSPHRASE_SALT, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return Ok(key);
}

/**
 * Generate a new random master key (for initial setup).
 * Returns a hex-encoded 256-bit (32 bytes = 64 hex chars) key.
 */
export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}
