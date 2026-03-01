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
];
