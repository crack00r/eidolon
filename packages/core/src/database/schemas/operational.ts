/**
 * Operational database schema migrations.
 *
 * Tables: sessions, events, loop_state, token_usage, scheduled_tasks,
 * discoveries, circuit_breakers, account_usage.
 */

import type { Migration } from "@eidolon/protocol";

export const OPERATIONAL_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "initial_operational_schema",
    database: "operational",
    up: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('main','task','learning','dream','voice','review')),
        status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed')),
        claude_session_id TEXT,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        completed_at INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX idx_sessions_status ON sessions(status);
      CREATE INDEX idx_sessions_type ON sessions(type);

      -- Event cleanup is handled by the housekeeping module (dreaming phase 1).
      -- Processed events are pruned after a configurable retention period.
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority TEXT NOT NULL CHECK(priority IN ('critical','high','normal','low')),
        payload TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        processed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;
      CREATE INDEX idx_events_priority ON events(priority, timestamp);
      CREATE INDEX idx_events_type ON events(type);

      CREATE TABLE loop_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_type TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX idx_token_usage_session ON token_usage(session_id);
      CREATE INDEX idx_token_usage_timestamp ON token_usage(timestamp);

      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('once','recurring','conditional')),
        cron TEXT,
        run_at INTEGER,
        condition TEXT,
        action TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_tasks_next_run ON scheduled_tasks(next_run_at) WHERE enabled = 1;

      CREATE TABLE discoveries (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        relevance_score REAL NOT NULL,
        safety_level TEXT NOT NULL CHECK(safety_level IN ('safe','needs_approval','dangerous')),
        status TEXT NOT NULL CHECK(status IN ('new','evaluated','approved','rejected','implemented')),
        implementation_branch TEXT,
        created_at INTEGER NOT NULL,
        evaluated_at INTEGER,
        implemented_at INTEGER
      );

      CREATE INDEX idx_discoveries_status ON discoveries(status);

      CREATE TABLE circuit_breakers (
        name TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('closed','open','half_open')),
        failures INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER,
        last_success_at INTEGER,
        next_probe_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE account_usage (
        account_name TEXT NOT NULL,
        hour_bucket INTEGER NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (account_name, hour_bucket)
      );
    `,
    down: `
      DROP TABLE IF EXISTS account_usage;
      DROP TABLE IF EXISTS circuit_breakers;
      DROP TABLE IF EXISTS discoveries;
      DROP TABLE IF EXISTS scheduled_tasks;
      DROP TABLE IF EXISTS token_usage;
      DROP TABLE IF EXISTS loop_state;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS sessions;
    `,
  },
  {
    version: 2,
    name: "add_events_claimed_at",
    database: "operational",
    up: `
      ALTER TABLE events ADD COLUMN claimed_at INTEGER;
      CREATE INDEX idx_events_claimed ON events(claimed_at) WHERE claimed_at IS NULL AND processed_at IS NULL;
    `,
    down: `
      DROP INDEX IF EXISTS idx_events_claimed;
      ALTER TABLE events DROP COLUMN claimed_at;
    `,
  },
  {
    version: 3,
    name: "add_performance_indexes",
    database: "operational",
    up: `
      -- Index on token_usage(model) for per-model cost analysis queries
      CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);

      -- Index on account_usage(hour_bucket) for time-range aggregation queries
      CREATE INDEX IF NOT EXISTS idx_account_usage_hour ON account_usage(hour_bucket);

      -- Composite index on events(type, timestamp) for filtered event queries
      CREATE INDEX IF NOT EXISTS idx_events_type_timestamp ON events(type, timestamp);
    `,
    down: `
      DROP INDEX IF EXISTS idx_events_type_timestamp;
      DROP INDEX IF EXISTS idx_account_usage_hour;
      DROP INDEX IF EXISTS idx_token_usage_model;
    `,
  },
  {
    version: 4,
    name: "add_device_tokens",
    database: "operational",
    up: `
      CREATE TABLE device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE INDEX idx_device_tokens_platform ON device_tokens(platform);
    `,
    down: `
      DROP INDEX IF EXISTS idx_device_tokens_platform;
      DROP TABLE IF EXISTS device_tokens;
    `,
  },
  {
    version: 5,
    name: "add_event_retention_tracking",
    database: "operational",
    up: `
      ALTER TABLE events ADD COLUMN retention_days INTEGER DEFAULT 30;
      CREATE INDEX IF NOT EXISTS idx_events_processed_cleanup ON events(processed_at) WHERE processed_at IS NOT NULL;
    `,
    down: `
      DROP INDEX IF EXISTS idx_events_processed_cleanup;
      ALTER TABLE events DROP COLUMN retention_days;
    `,
  },
];
