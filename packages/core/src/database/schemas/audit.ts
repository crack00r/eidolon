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
];
