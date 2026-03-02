/**
 * Master key management for the secret store.
 *
 * In production, set EIDOLON_MASTER_KEY as an environment variable.
 * The value should be a hex-encoded 256-bit key (64 hex chars).
 * Shorter values (passphrases) are derived via scrypt KDF to produce a 32-byte key.
 *
 * @security
 * - The master key encrypts all secrets at rest in the SecretStore.
 * - Passphrases shorter than 12 characters trigger a console warning.
 * - The fixed application salt is an accepted trade-off for a single-user daemon
 *   (see inline comment in {@link getMasterKey} for full rationale).
 */

import { randomBytes, scryptSync } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { KEY_LENGTH, SCRYPT_MAXMEM, SCRYPT_N, SCRYPT_P, SCRYPT_R } from "./crypto.ts";

/** Environment variable name for the master key. */
const ENV_KEY = "EIDOLON_MASTER_KEY";

/**
 * Fixed application-level salt for passphrase-based key derivation.
 *
 * Using a fixed salt is an accepted trade-off because:
 * 1. The scrypt cost factor (N=2^17) makes brute-force infeasible.
 * 2. The key protects a local secret store, not a multi-user password database.
 * 3. A per-installation random salt would require persistent storage, adding
 *    complexity without meaningful security gain for a single-user daemon.
 */
const PASSPHRASE_SALT = Buffer.from("eidolon-master-key-v1", "utf-8");

/** Minimum recommended passphrase length (characters). */
const MIN_PASSPHRASE_LENGTH = 12;

/** Expected length of a hex-encoded 256-bit key. */
const HEX_KEY_LENGTH = KEY_LENGTH * 2; // 64

/**
 * Zero out a Buffer to remove key material from memory.
 *
 * Best-effort in JavaScript — the GC may have already copied the data,
 * but this eliminates the primary reference. Call this on any Buffer
 * containing key material, derived keys, or plaintext secrets as soon
 * as the value is no longer needed.
 */
export function zeroBuffer(buf: Buffer | Uint8Array): void {
  buf.fill(0);
}

/**
 * Get the master key from the EIDOLON_MASTER_KEY environment variable.
 *
 * - If the value is exactly 64 hex characters, it is decoded directly as a 32-byte key.
 * - Otherwise, the value is treated as a passphrase and derived via scrypt KDF
 *   (N=2^17, r=8, p=1) with a fixed application salt.
 *
 * @returns A 32-byte Buffer on success. **Caller should zeroize with {@link zeroBuffer}
 *          when the key is no longer needed.**
 *
 * @security
 * - Rejects empty environment variable values.
 * - Warns on passphrases shorter than {@link MIN_PASSPHRASE_LENGTH} characters.
 * - Uses the same scrypt parameters as {@link import("./crypto.js").deriveKey}.
 */
export function getMasterKey(): Result<Buffer, EidolonError> {
  const envValue = process.env[ENV_KEY];
  if (!envValue || envValue.length === 0) {
    return Err(createError(ErrorCode.MASTER_KEY_MISSING, `Master key not set. Set ${ENV_KEY} environment variable.`));
  }

  // If it looks like hex (64 chars), decode directly
  const hexPattern = new RegExp(`^[0-9a-fA-F]{${HEX_KEY_LENGTH}}$`);
  if (hexPattern.test(envValue)) {
    return Ok(Buffer.from(envValue, "hex"));
  }

  // Warn if passphrase is too short for meaningful key derivation security
  if (envValue.length < MIN_PASSPHRASE_LENGTH) {
    console.warn(
      `[eidolon:master-key] WARNING: Passphrase is shorter than ${MIN_PASSPHRASE_LENGTH} characters. ` +
        "Consider using a longer passphrase for better security.",
    );
  }

  // Derive key from passphrase via scrypt KDF (with fixed application salt).
  // Using scrypt because Bun doesn't natively support argon2id. Parameters
  // (N=2^17, r=8, p=1) provide an equivalent security margin to argon2id with
  // recommended settings. If Bun gains argon2id support in the future, this
  // should be migrated. See SEC-SUPPLY-022.
  const key = scryptSync(envValue, PASSPHRASE_SALT, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return Ok(key);
}

/**
 * Generate a new cryptographically random master key for initial setup.
 *
 * @returns Hex-encoded 256-bit key (64 hex characters). Suitable for direct
 *          use as EIDOLON_MASTER_KEY environment variable.
 *
 * @security Uses `crypto.randomBytes` which reads from the OS CSPRNG.
 */
export function generateMasterKey(): string {
  return randomBytes(KEY_LENGTH).toString("hex");
}
