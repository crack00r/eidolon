/**
 * KDF helper for the onboard wizard.
 *
 * Derives a 32-byte Buffer from a master key string.
 * Hex-encoded 64-char strings are decoded directly; all others
 * go through scrypt KDF with the same parameters used by the core.
 */

import { scryptSync } from "node:crypto";
import { KEY_LENGTH, PASSPHRASE_SALT, SCRYPT_MAXMEM, SCRYPT_N, SCRYPT_P, SCRYPT_R } from "@eidolon/core";

const SCRYPT_PARAMS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };

export function deriveMasterKeyBuffer(masterKey: string): Buffer {
  const hexKeyLength = KEY_LENGTH * 2;
  if (new RegExp(`^[0-9a-fA-F]{${hexKeyLength}}$`).test(masterKey)) {
    return Buffer.from(masterKey, "hex");
  }
  return scryptSync(masterKey, PASSPHRASE_SALT, KEY_LENGTH, SCRYPT_PARAMS);
}
