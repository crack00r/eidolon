/**
 * TLS certificate management utilities for the gateway server.
 *
 * Provides self-signed certificate generation via OpenSSL
 * and certificate file existence checks.
 */

import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "@eidolon/protocol";
import { Err, Ok } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CertPaths {
  readonly certPath: string;
  readonly keyPath: string;
}

interface CertOptions {
  readonly hostname?: string;
  readonly days?: number;
}

/** RSA key size in bits for self-signed certificate generation. */
const RSA_KEY_BITS = 4096;

/** Default certificate validity period in days. */
const DEFAULT_CERT_DAYS = 365;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a self-signed TLS certificate using OpenSSL.
 *
 * Creates `cert.pem` and `key.pem` in the given directory.
 * Key file permissions are set to 600 (owner-only).
 */
export function generateSelfSignedCert(certsDir: string, options?: CertOptions): Result<CertPaths, string> {
  const hostname = options?.hostname ?? "localhost";
  const days = options?.days ?? DEFAULT_CERT_DAYS;

  // Validate hostname to prevent injection in OpenSSL -subj argument
  const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/;
  if (!HOSTNAME_RE.test(hostname)) {
    return Err(`Invalid hostname: ${hostname}`);
  }

  const certPath = join(certsDir, "cert.pem");
  const keyPath = join(certsDir, "key.pem");

  const result = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    `rsa:${RSA_KEY_BITS}`,
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    String(days),
    "-nodes",
    "-subj",
    `/CN=${hostname}`,
  ]);

  if (result.exitCode !== 0) {
    const stderr = result.stderr?.toString() ?? "Unknown error";
    return Err(`Failed to generate self-signed cert: ${stderr}`);
  }

  // Restrict key file permissions to owner-only
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    return Err(`Certificate generated but failed to set key permissions on ${keyPath}`);
  }

  return Ok({ certPath, keyPath });
}

/**
 * Check whether cert.pem and key.pem exist in the given directory.
 */
export function certExists(certsDir: string): boolean {
  return existsSync(join(certsDir, "cert.pem")) && existsSync(join(certsDir, "key.pem"));
}
