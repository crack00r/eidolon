/**
 * AES-256-GCM encryption with scrypt key derivation.
 *
 * Uses Node.js built-in `crypto` module (works in Bun).
 * Key derivation uses scrypt (N=2^17, r=8, p=1) which provides strong
 * protection without external dependencies. Can be upgraded to Argon2id
 * later once Bun compatibility is verified.
 *
 * Security properties:
 * - Each encryption uses a fresh random salt and IV (no nonce reuse).
 * - Derived keys and plaintext buffers are zeroized after use (best-effort).
 * - GCM auth tag provides authenticated encryption (integrity + confidentiality).
 * - scrypt cost factor N=2^17 provides ~128-bit security against brute-force.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Crypto constants -- all magic numbers extracted for auditability
// ---------------------------------------------------------------------------

/** AES-256-GCM symmetric cipher identifier. */
const ALGORITHM = "aes-256-gcm";
/** GCM recommended IV length: 96 bits (NIST SP 800-38D §8.2.1). */
const IV_LENGTH = 12;
/** GCM authentication tag length: 128 bits (maximum, NIST SP 800-38D §5.2.1.2). */
const AUTH_TAG_LENGTH = 16;
/** Per-encryption random salt length: 256 bits. */
const SALT_LENGTH = 32;
/** Derived key length: 256 bits (matches AES-256). */
export const KEY_LENGTH = 32;
/** scrypt cost parameter: N=2^17 (131 072). Higher values increase memory and CPU cost. */
export const SCRYPT_N = 2 ** 17;
/** scrypt block size parameter. r=8 is the standard recommendation. */
export const SCRYPT_R = 8;
/** scrypt parallelization parameter. p=1 is sufficient for single-threaded derivation. */
export const SCRYPT_P = 1;
/** scrypt memory ceiling: 256 MiB. Required for N=2^17 under Bun's OpenSSL defaults. */
export const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * Fixed application-level salt for passphrase-based key derivation.
 *
 * Exported so that all modules (master-key.ts, onboard.ts, etc.) use the same value.
 * Using a fixed salt is an accepted trade-off for a single-user daemon (see master-key.ts).
 */
export const PASSPHRASE_SALT = Buffer.from("eidolon-master-key-v1", "utf-8");

/**
 * Maximum plaintext length accepted by {@link encrypt}.
 * Prevents excessive memory allocation from untrusted input.
 * 1 MiB is generous for secrets (API keys, tokens, certificates).
 */
const MAX_PLAINTEXT_LENGTH = 1024 * 1024;

export interface EncryptedData {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly salt: Buffer;
}

/**
 * Derive a 256-bit encryption key from a master key and per-operation salt
 * using the scrypt key derivation function.
 *
 * @param masterKey - 32-byte master key material. Caller must zeroize after use.
 * @param salt      - Unique random salt (at least 16 bytes; 32 bytes recommended).
 * @returns Derived 32-byte key. **Caller is responsible for zeroizing the returned buffer.**
 *
 * @security Uses scrypt with N=2^17, r=8, p=1 (~128-bit brute-force resistance).
 */
export function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
}

/**
 * Encrypt a plaintext string using AES-256-GCM with a per-operation random salt and IV.
 *
 * @param value     - Plaintext to encrypt. Must be non-empty and ≤ 1 MiB.
 * @param masterKey - 32-byte master key. Not modified or zeroized by this function.
 * @returns Encrypted envelope (ciphertext + IV + auth tag + salt) on success.
 *
 * @security
 * - A fresh 256-bit salt and 96-bit IV are generated per call via `crypto.randomBytes`.
 * - The derived key is zeroized in the `finally` block (best-effort in JS/GC environments).
 * - Empty input is rejected to prevent storing meaningless encrypted blobs.
 */
export function encrypt(value: string, masterKey: Buffer): Result<EncryptedData, EidolonError> {
  if (value.length === 0) {
    return Err(createError(ErrorCode.SECRET_ENCRYPTION_FAILED, "Encryption failed: value must not be empty"));
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PLAINTEXT_LENGTH) {
    return Err(createError(ErrorCode.SECRET_ENCRYPTION_FAILED, "Encryption failed: value exceeds maximum length"));
  }

  let key: Buffer | undefined;
  try {
    const salt = randomBytes(SALT_LENGTH);
    key = deriveKey(masterKey, salt);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Ok({ ciphertext: encrypted, iv, authTag, salt });
  } catch (cause) {
    return Err(createError(ErrorCode.SECRET_ENCRYPTION_FAILED, "Encryption failed", cause));
  } finally {
    // Zero derived key material (best-effort in JS)
    if (key) key.fill(0);
  }
}

/**
 * Decrypt an AES-256-GCM encrypted envelope back to the original plaintext.
 *
 * @param data      - Encrypted envelope previously produced by {@link encrypt}.
 * @param masterKey - 32-byte master key matching the one used during encryption.
 * @returns Decrypted plaintext on success; error if key is wrong or data is tampered.
 *
 * @security
 * - GCM authentication is verified before any plaintext is returned.
 * - Both the derived key and the plaintext buffer are zeroized after extracting the string
 *   (best-effort; the JS string itself is immutable and managed by the GC).
 * - Error messages are generic to avoid leaking cryptographic details.
 */
export function decrypt(data: EncryptedData, masterKey: Buffer): Result<string, EidolonError> {
  let key: Buffer | undefined;
  let decryptedBuf: Buffer | undefined;
  try {
    key = deriveKey(masterKey, data.salt);
    const decipher = createDecipheriv(ALGORITHM, key, data.iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(data.authTag);
    decryptedBuf = Buffer.concat([decipher.update(data.ciphertext), decipher.final()]);
    const plaintext = decryptedBuf.toString("utf8");
    return Ok(plaintext);
  } catch (cause) {
    return Err(
      createError(ErrorCode.SECRET_DECRYPTION_FAILED, "Decryption failed -- wrong key or tampered data", cause),
    );
  } finally {
    // Zero derived key material (best-effort in JS)
    if (key) key.fill(0);
    // Zero plaintext buffer to reduce window of exposure
    if (decryptedBuf) decryptedBuf.fill(0);
  }
}
