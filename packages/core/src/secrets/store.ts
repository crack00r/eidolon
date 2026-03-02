/**
 * Encrypted secret store using AES-256-GCM with SQLite backend.
 *
 * Secrets are stored in a separate SQLite database (secrets.db).
 * Values are encrypted at rest; only metadata (key name, timestamps,
 * description) is stored in plaintext.
 *
 * @security
 * - Database file permissions are restricted to 0o600 (owner-only).
 * - Secret values never appear in plaintext in the database.
 * - The `list()` method deliberately excludes encrypted values.
 * - Key names are validated to prevent empty or excessively long keys.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import type { EidolonConfig, EidolonError, Result, SecretMetadata } from "@eidolon/protocol";
import { createError, EidolonConfigSchema, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { decrypt, encrypt } from "./crypto.ts";

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

/** Maximum length for a secret key name (bytes). Prevents abuse and SQLite issues. */
const MAX_KEY_LENGTH = 256;

/** Maximum length for a secret description (bytes). */
const MAX_DESCRIPTION_LENGTH = 1024;

/** Pattern for valid secret key names: alphanumeric, hyphens, underscores, dots, slashes. */
const VALID_KEY_PATTERN = /^[a-zA-Z0-9._\-/]+$/;

/** Row shape returned by SQLite for secret value queries. */
interface SecretRow {
  readonly encrypted_value: Buffer;
  readonly iv: Buffer;
  readonly auth_tag: Buffer;
  readonly salt: Buffer;
}

/** Row shape returned by SQLite for metadata queries. */
interface MetadataRow {
  readonly key: string;
  readonly description: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly accessed_at: number;
}

/**
 * Encrypted secret store using AES-256-GCM.
 * Secrets are stored in a separate SQLite database (secrets.db).
 *
 * @security
 * - The `masterKey` buffer is held for the lifetime of the store instance.
 *   Call {@link close} when done; the caller is responsible for zeroizing the
 *   master key buffer after the store is closed.
 * - All encryption/decryption is delegated to {@link encrypt}/{@link decrypt}
 *   which handle per-operation key derivation and zeroization.
 */
export class SecretStore {
  private readonly db: Database;
  private readonly masterKey: Buffer;
  private readonly logger: Logger | undefined;

  /**
   * @param dbPath    - Path to the SQLite database file, or `":memory:"` for tests.
   * @param masterKey - 32-byte master encryption key. The buffer is referenced (not copied)
   *                    and must remain valid for the lifetime of the store.
   * @param logger    - Optional structured logger for audit-grade secret access logging.
   */
  constructor(dbPath: string, masterKey: Buffer, logger?: Logger) {
    this.db = new Database(dbPath, { create: true });
    this.masterKey = masterKey;
    this.logger = logger?.child("secrets");
    this.restrictFilePermissions(dbPath);
    this.initialize();
  }

  /** Restrict secrets database file permissions to owner-only (0o600). */
  private restrictFilePermissions(dbPath: string): void {
    if (dbPath === ":memory:") return;
    try {
      chmodSync(dbPath, 0o600);
      // Also restrict WAL and SHM files if they exist
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (existsSync(walPath)) chmodSync(walPath, 0o600);
      if (existsSync(shmPath)) chmodSync(shmPath, 0o600);
    } catch {
      // Best-effort: may fail on non-POSIX systems (e.g., Windows)
    }
  }

  private initialize(): void {
    this.db.exec("PRAGMA journal_mode=WAL");
    // SEC: Overwrite deleted content on disk instead of marking as free.
    // Prevents recovery of plaintext fragments after DELETE operations.
    this.db.exec("PRAGMA secure_delete=ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY,
        encrypted_value BLOB NOT NULL,
        iv BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        salt BLOB NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * Store or update an encrypted secret.
   *
   * @param key         - Unique identifier (alphanumeric, hyphens, underscores, dots, slashes; max 256 chars).
   * @param value       - Plaintext secret value. Must be non-empty.
   * @param description - Optional human-readable description (stored unencrypted; max 1024 chars).
   *
   * @security The plaintext `value` is passed to {@link encrypt} which handles
   *           key derivation and zeroization of derived material.
   */
  set(key: string, value: string, description?: string): Result<void, EidolonError> {
    const keyValidation = this.validateKey(key);
    if (!keyValidation.ok) return keyValidation;

    if (description !== undefined && description.length > MAX_DESCRIPTION_LENGTH) {
      return Err(createError(ErrorCode.SECRET_DECRYPTION_FAILED, "Description exceeds maximum length"));
    }

    const encrypted = encrypt(value, this.masterKey);
    if (!encrypted.ok) return encrypted;

    const now = Date.now();
    const existing = this.db.query("SELECT key FROM secrets WHERE key = ?").get(key);

    if (existing) {
      this.db
        .query(
          `UPDATE secrets SET encrypted_value = ?, iv = ?, auth_tag = ?, salt = ?,
        description = COALESCE(?, description), updated_at = ?
        WHERE key = ?`,
        )
        .run(
          encrypted.value.ciphertext,
          encrypted.value.iv,
          encrypted.value.authTag,
          encrypted.value.salt,
          description ?? null,
          now,
          key,
        );
      this.logger?.info("set", `Secret updated: ${key}`);
    } else {
      this.db
        .query(
          `INSERT INTO secrets (key, encrypted_value, iv, auth_tag, salt, description, created_at, updated_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          encrypted.value.ciphertext,
          encrypted.value.iv,
          encrypted.value.authTag,
          encrypted.value.salt,
          description ?? null,
          now,
          now,
          now,
        );
      this.logger?.info("set", `Secret created: ${key}`);
    }

    return Ok(undefined);
  }

  /**
   * Retrieve and decrypt a secret.
   *
   * @param key - The secret key name to look up.
   * @returns Decrypted plaintext value on success.
   *
   * @security The returned string is an immutable JS string managed by the GC.
   *           There is no reliable way to zeroize it; callers should minimize its
   *           lifetime and scope.
   */
  get(key: string): Result<string, EidolonError> {
    const keyValidation = this.validateKey(key);
    if (!keyValidation.ok) return keyValidation;

    const row = this.db
      .query("SELECT encrypted_value, iv, auth_tag, salt FROM secrets WHERE key = ?")
      .get(key) as SecretRow | null;

    if (!row) {
      this.logger?.warn("get", `Secret not found: ${key}`);
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, `Secret '${key}' not found`));
    }

    // SEC: Decrypt BEFORE updating accessed_at to prevent timing oracle.
    // If we update accessed_at first, an attacker can determine key existence
    // by measuring response time (existing keys take longer due to the UPDATE).
    const result = decrypt(
      {
        ciphertext: Buffer.from(row.encrypted_value),
        iv: Buffer.from(row.iv),
        authTag: Buffer.from(row.auth_tag),
        salt: Buffer.from(row.salt),
      },
      this.masterKey,
    );

    if (result.ok) {
      // Only update accessed_at on successful decryption
      this.db.query("UPDATE secrets SET accessed_at = ? WHERE key = ?").run(Date.now(), key);
    } else {
      this.logger?.warn("get", `Decryption failed for secret: ${key}`);
    }

    return result;
  }

  /**
   * Delete a secret and its encrypted data from the database.
   *
   * @param key - The secret key name to delete.
   */
  delete(key: string): Result<void, EidolonError> {
    const keyValidation = this.validateKey(key);
    if (!keyValidation.ok) return keyValidation;

    const result = this.db.query("DELETE FROM secrets WHERE key = ?").run(key);
    if (result.changes === 0) {
      this.logger?.warn("delete", `Secret not found for deletion: ${key}`);
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, `Secret '${key}' not found`));
    }
    this.logger?.info("delete", `Secret deleted: ${key}`);
    return Ok(undefined);
  }

  /** List all secret metadata (never returns values). */
  list(): Result<SecretMetadata[], EidolonError> {
    const rows = this.db
      .query("SELECT key, description, created_at, updated_at, accessed_at FROM secrets ORDER BY key")
      .all() as MetadataRow[];

    return Ok(
      rows.map((r) => ({
        key: r.key,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        accessedAt: r.accessed_at,
        description: r.description ?? undefined,
      })),
    );
  }

  /**
   * Check if a secret exists without decrypting it.
   *
   * @param key - The secret key name to check.
   */
  has(key: string): boolean {
    if (!key || key.length > MAX_KEY_LENGTH || !VALID_KEY_PATTERN.test(key)) return false;
    const row = this.db.query("SELECT 1 FROM secrets WHERE key = ?").get(key);
    return row !== null;
  }

  /**
   * Rotate (update) a secret's encryption with a new plaintext value.
   * The secret must already exist.
   *
   * @param key      - The secret key name to rotate.
   * @param newValue - New plaintext value. Must be non-empty.
   */
  rotate(key: string, newValue: string): Result<void, EidolonError> {
    if (!this.has(key)) {
      this.logger?.warn("rotate", `Secret not found for rotation: ${key}`);
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, `Secret '${key}' not found`));
    }
    this.logger?.info("rotate", `Secret rotated: ${key}`);
    return this.set(key, newValue);
  }

  /**
   * Resolve `{ "$secret": "KEY" }` references in a config object.
   * Walks the config tree and replaces SecretRef objects with decrypted values.
   * Re-validates the resolved config against the Zod schema to ensure type safety.
   */
  resolveSecretRefs(config: EidolonConfig): Result<EidolonConfig, EidolonError> {
    const resolved = this.resolveRefs(structuredClone(config) as unknown);
    if (!resolved.ok) return resolved as Result<EidolonConfig, EidolonError>;

    // SEC: Re-validate with Zod after secret resolution to prevent unsafe type casts.
    // Secret values may not match the expected schema (e.g., empty string for a required field).
    const parseResult = EidolonConfigSchema.safeParse(resolved.value);
    if (!parseResult.success) {
      this.logger?.error(
        "resolveSecretRefs",
        "Config validation failed after secret resolution",
        parseResult.error,
      );
      return Err(
        createError(
          ErrorCode.CONFIG_INVALID,
          `Config invalid after secret resolution: ${parseResult.error.issues.map((i) => i.message).join(", ")}`,
        ),
      );
    }

    return Ok(parseResult.data);
  }

  private resolveRefs(obj: unknown): Result<unknown, EidolonError> {
    if (obj === null || obj === undefined) return Ok(obj);
    if (typeof obj !== "object") return Ok(obj);

    if (Array.isArray(obj)) {
      const resolved: unknown[] = [];
      for (const item of obj) {
        const r = this.resolveRefs(item);
        if (!r.ok) return r;
        resolved.push(r.value);
      }
      return Ok(resolved);
    }

    const record = obj as Record<string, unknown>;
    // Check if this is a SecretRef
    if ("$secret" in record && typeof record.$secret === "string") {
      return this.get(record.$secret);
    }

    // Recurse into object
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      const r = this.resolveRefs(v);
      if (!r.ok) return r;
      resolved[k] = r.value;
    }
    return Ok(resolved);
  }

  /**
   * Validate a secret key name.
   * Rejects empty keys, keys exceeding max length, and keys with invalid characters.
   */
  private validateKey(key: string): Result<void, EidolonError> {
    if (!key || key.length === 0) {
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, "Secret key must not be empty"));
    }
    if (key.length > MAX_KEY_LENGTH) {
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, "Secret key exceeds maximum length"));
    }
    if (!VALID_KEY_PATTERN.test(key)) {
      return Err(
        createError(
          ErrorCode.SECRET_NOT_FOUND,
          "Secret key contains invalid characters (allowed: alphanumeric, hyphens, underscores, dots, slashes)",
        ),
      );
    }
    return Ok(undefined);
  }

  /**
   * Close the database connection and zeroize the master key buffer.
   *
   * @security The master key is overwritten with zeros before releasing
   *           the reference. This is best-effort in a GC environment but
   *           eliminates the primary copy from memory.
   */
  close(): void {
    try {
      this.db.close();
    } finally {
      // SEC: Zero out the master key buffer to prevent residual key material
      // in memory after the store is closed.
      this.masterKey.fill(0);
    }
  }
}
