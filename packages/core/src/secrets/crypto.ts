/**
 * AES-256-GCM encryption with scrypt key derivation.
 *
 * Uses Node.js built-in `crypto` module (works in Bun).
 * Key derivation uses scrypt (N=2^17, r=8, p=1) which provides strong
 * protection without external dependencies. Can be upgraded to Argon2id
 * later once Bun compatibility is verified.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits
const KEY_LENGTH = 32; // 256 bits
const SCRYPT_N = 2 ** 17; // 131072 -- cost parameter
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelization
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256 MB -- required for N=2^17 in Bun's OpenSSL

export interface EncryptedData {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly salt: Buffer;
}

/** Derive a 256-bit key from a master key using scrypt. */
export function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Buffer;
}

/** Encrypt a value using AES-256-GCM. */
export function encrypt(value: string, masterKey: Buffer): Result<EncryptedData, EidolonError> {
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
    return Err(createError(ErrorCode.SECRET_DECRYPTION_FAILED, "Encryption failed", cause));
  } finally {
    // Zero derived key material (best-effort in JS)
    if (key) key.fill(0);
  }
}

/** Decrypt a value using AES-256-GCM. */
export function decrypt(data: EncryptedData, masterKey: Buffer): Result<string, EidolonError> {
  let key: Buffer | undefined;
  try {
    key = deriveKey(masterKey, data.salt);
    const decipher = createDecipheriv(ALGORITHM, key, data.iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(data.authTag);
    const decrypted = Buffer.concat([decipher.update(data.ciphertext), decipher.final()]);
    return Ok(decrypted.toString("utf8"));
  } catch (cause) {
    return Err(
      createError(ErrorCode.SECRET_DECRYPTION_FAILED, "Decryption failed -- wrong key or tampered data", cause),
    );
  } finally {
    // Zero derived key material (best-effort in JS)
    if (key) key.fill(0);
  }
}
