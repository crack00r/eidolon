/**
 * Audit database schema migrations.
 *
 * Tables: audit_log (append-only, rotatable).
 */

import type { Migration } from "@eidolon/protocol";

export const AUDIT_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "initial_audit_schema",
    database: "audit",
    up: `
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('success','failure','denied')),
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX idx_audit_actor ON audit_log(actor);
      CREATE INDEX idx_audit_action ON audit_log(action);
    `,
    down: `
      DROP TABLE IF EXISTS audit_log;
    `,
  },
  {
    version: 2,
    name: "add_audit_security_indexes",
    database: "audit",
    up: `
      -- Index on result for filtering failed/denied operations (security monitoring)
      CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result);

      -- Composite index on actor + action for combined security queries
      CREATE INDEX IF NOT EXISTS idx_audit_actor_action ON audit_log(actor, action);

      -- Composite index on timestamp + result for time-windowed security scans
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp_result ON audit_log(timestamp, result);
    `,
    down: `
      DROP INDEX IF EXISTS idx_audit_timestamp_result;
      DROP INDEX IF EXISTS idx_audit_actor_action;
      DROP INDEX IF EXISTS idx_audit_result;
    `,
  },
  {
    version: 3,
    name: "add_integrity_hash_and_tamper_protection",
    database: "audit",
    up: `
      -- Add integrity_hash column for SHA-256 hash chain (tamper detection).
      -- Each entry's hash is SHA-256(previous_hash | entry_data).
      ALTER TABLE audit_log ADD COLUMN integrity_hash TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_audit_integrity ON audit_log(integrity_hash);

      -- Prevent UPDATE on audit_log (append-only)
      CREATE TRIGGER IF NOT EXISTS audit_no_update
        BEFORE UPDATE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'Audit log entries cannot be modified');
        END;

      -- Prevent DELETE on audit_log (append-only)
      CREATE TRIGGER IF NOT EXISTS audit_no_delete
        BEFORE DELETE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'Audit log entries cannot be deleted');
        END;
    `,
    down: `
      DROP TRIGGER IF EXISTS audit_no_delete;
      DROP TRIGGER IF EXISTS audit_no_update;
      DROP INDEX IF EXISTS idx_audit_integrity;
      -- SQLite cannot drop columns in older versions; integrity_hash column remains.
    `,
  },
];
