/**
 * Encrypted secret store using AES-256-GCM with SQLite backend.
 *
 * Secrets are stored in a separate SQLite database (secrets.db).
 * Values are encrypted at rest; only metadata (key name, timestamps,
 * description) is stored in plaintext.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import type { EidolonConfig, EidolonError, Result, SecretMetadata } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { decrypt, encrypt } from "./crypto.js";

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
 */
export class SecretStore {
  private readonly db: Database;
  private readonly masterKey: Buffer;

  constructor(dbPath: string, masterKey: Buffer) {
    this.db = new Database(dbPath, { create: true });
    this.masterKey = masterKey;
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

  /** Store or update an encrypted secret. */
  set(key: string, value: string, description?: string): Result<void, EidolonError> {
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
    }

    return Ok(undefined);
  }

  /** Retrieve and decrypt a secret. */
  get(key: string): Result<string, EidolonError> {
    const row = this.db
      .query("SELECT encrypted_value, iv, auth_tag, salt FROM secrets WHERE key = ?")
      .get(key) as SecretRow | null;

    if (!row) {
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, `Secret '${key}' not found`));
    }

    // Update accessed_at
    this.db.query("UPDATE secrets SET accessed_at = ? WHERE key = ?").run(Date.now(), key);

    return decrypt(
      {
        ciphertext: Buffer.from(row.encrypted_value),
        iv: Buffer.from(row.iv),
        authTag: Buffer.from(row.auth_tag),
        salt: Buffer.from(row.salt),
      },
      this.masterKey,
    );
  }

  /** Delete a secret. */
  delete(key: string): Result<void, EidolonError> {
    const result = this.db.query("DELETE FROM secrets WHERE key = ?").run(key);
    if (result.changes === 0) {
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, `Secret '${key}' not found`));
    }
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

  /** Check if a secret exists. */
  has(key: string): boolean {
    const row = this.db.query("SELECT 1 FROM secrets WHERE key = ?").get(key);
    return row !== null;
  }

  /** Rotate (update) a secret's value. */
  rotate(key: string, newValue: string): Result<void, EidolonError> {
    if (!this.has(key)) {
      return Err(createError(ErrorCode.SECRET_NOT_FOUND, `Secret '${key}' not found`));
    }
    return this.set(key, newValue);
  }

  /**
   * Resolve `{ "$secret": "KEY" }` references in a config object.
   * Walks the config tree and replaces SecretRef objects with decrypted values.
   */
  resolveSecretRefs(config: EidolonConfig): Result<EidolonConfig, EidolonError> {
    const resolved = this.resolveRefs(structuredClone(config) as unknown);
    if (!resolved.ok) return resolved as Result<EidolonConfig, EidolonError>;
    return Ok(resolved.value as EidolonConfig);
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

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
