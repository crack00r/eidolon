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
  {
    version: 6,
    name: "add_user_consent",
    database: "operational",
    up: `
      CREATE TABLE user_consent (
        id TEXT PRIMARY KEY,
        consent_type TEXT NOT NULL CHECK(consent_type IN ('memory_extraction','data_processing')),
        granted INTEGER NOT NULL CHECK(granted IN (0, 1)),
        granted_at INTEGER,
        revoked_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX idx_user_consent_type ON user_consent(consent_type);
    `,
    down: `
      DROP INDEX IF EXISTS idx_user_consent_type;
      DROP TABLE IF EXISTS user_consent;
    `,
  },
  {
    version: 7,
    name: "add_learning_journal",
    database: "operational",
    up: `
      -- ERR-007: Persist learning journal entries so they survive daemon restarts.
      CREATE TABLE learning_journal (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('discovery','evaluation','approval','rejection','implementation','error')),
        timestamp INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX idx_learning_journal_timestamp ON learning_journal(timestamp);
      CREATE INDEX idx_learning_journal_type ON learning_journal(type);
    `,
    down: `
      DROP INDEX IF EXISTS idx_learning_journal_type;
      DROP INDEX IF EXISTS idx_learning_journal_timestamp;
      DROP TABLE IF EXISTS learning_journal;
    `,
  },
  {
    version: 8,
    name: "add_feedback_table",
    database: "operational",
    up: `
      CREATE TABLE feedback (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
        channel TEXT NOT NULL,
        comment TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_feedback_session ON feedback(session_id);
      CREATE INDEX idx_feedback_created ON feedback(created_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_feedback_created;
      DROP INDEX IF EXISTS idx_feedback_session;
      DROP TABLE IF EXISTS feedback;
    `,
  },
  {
    version: 9,
    name: "add_approval_requests",
    database: "operational",
    up: `
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('safe','needs_approval','dangerous')),
        description TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        timeout_at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','timeout','escalated')),
        responded_by TEXT,
        responded_at INTEGER,
        escalation_level INTEGER NOT NULL DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX idx_approval_requests_status ON approval_requests(status);
      CREATE INDEX idx_approval_requests_timeout ON approval_requests(timeout_at) WHERE status = 'pending';
    `,
    down: `
      DROP INDEX IF EXISTS idx_approval_requests_timeout;
      DROP INDEX IF EXISTS idx_approval_requests_status;
      DROP TABLE IF EXISTS approval_requests;
    `,
  },
  {
    version: 10,
    name: "add_calendar_events",
    database: "operational",
    up: `
      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('google', 'caldav', 'manual')),
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0,
        recurrence TEXT,
        reminders TEXT NOT NULL DEFAULT '[]',
        raw_data TEXT,
        sync_token TEXT,
        synced_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_calendar_events_time ON calendar_events(start_time, end_time);
      CREATE INDEX idx_calendar_events_provider ON calendar_events(provider);
      CREATE INDEX idx_calendar_events_calendar ON calendar_events(calendar_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_calendar_events_calendar;
      DROP INDEX IF EXISTS idx_calendar_events_provider;
      DROP INDEX IF EXISTS idx_calendar_events_time;
      DROP TABLE IF EXISTS calendar_events;
    `,
  },
  {
    version: 11,
    name: "add_home_automation_tables",
    database: "operational",
    up: `
      CREATE TABLE IF NOT EXISTS ha_entities (
        entity_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        friendly_name TEXT NOT NULL,
        state TEXT NOT NULL,
        attributes TEXT NOT NULL DEFAULT '{}',
        last_changed INTEGER NOT NULL,
        synced_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ha_scenes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        actions TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_executed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_ha_entities_domain ON ha_entities(domain);
    `,
    down: `
      DROP INDEX IF EXISTS idx_ha_entities_domain;
      DROP TABLE IF EXISTS ha_scenes;
      DROP TABLE IF EXISTS ha_entities;
    `,
  },
  {
    version: 12,
    name: "add_users_table",
    database: "operational",
    up: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel_mappings TEXT NOT NULL DEFAULT '[]',
        preferences TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX idx_users_created_at ON users(created_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_users_created_at;
      DROP TABLE IF EXISTS users;
    `,
  },
  {
    version: 13,
    name: "add_projects_tables",
    database: "operational",
    up: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        repo_path TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        last_synced_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX idx_projects_name ON projects(name);

      CREATE TABLE project_journal (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        period TEXT NOT NULL CHECK(period IN ('daily','weekly')),
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        summary TEXT NOT NULL,
        commit_count INTEGER NOT NULL DEFAULT 0,
        files_changed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_project_journal_project ON project_journal(project_id);
      CREATE INDEX idx_project_journal_period ON project_journal(period_start, period_end);
    `,
    down: `
      DROP INDEX IF EXISTS idx_project_journal_period;
      DROP INDEX IF EXISTS idx_project_journal_project;
      DROP TABLE IF EXISTS project_journal;
      DROP INDEX IF EXISTS idx_projects_name;
      DROP TABLE IF EXISTS projects;
    `,
  },
  {
    version: 14,
    name: "add_anticipation_tables",
    database: "operational",
    up: `
      CREATE TABLE anticipation_history (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        detector_id TEXT NOT NULL,
        entity_key TEXT,
        confidence REAL NOT NULL,
        suggestion_title TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        dismissed_at INTEGER,
        acted_on_at INTEGER,
        feedback TEXT
      );

      CREATE INDEX idx_anticipation_pattern_type ON anticipation_history(pattern_type);
      CREATE INDEX idx_anticipation_entity_key ON anticipation_history(entity_key);
      CREATE INDEX idx_anticipation_fired_at ON anticipation_history(fired_at);

      CREATE TABLE anticipation_suppressions (
        id TEXT PRIMARY KEY,
        pattern_type TEXT NOT NULL,
        entity_key TEXT,
        suppressed_at INTEGER NOT NULL,
        expires_at INTEGER,
        reason TEXT NOT NULL
      );

      CREATE INDEX idx_suppression_pattern ON anticipation_suppressions(pattern_type);
    `,
    down: `
      DROP INDEX IF EXISTS idx_suppression_pattern;
      DROP TABLE IF EXISTS anticipation_suppressions;
      DROP INDEX IF EXISTS idx_anticipation_fired_at;
      DROP INDEX IF EXISTS idx_anticipation_entity_key;
      DROP INDEX IF EXISTS idx_anticipation_pattern_type;
      DROP TABLE IF EXISTS anticipation_history;
    `,
  },
  {
    version: 15,
    name: "add_workflow_tables",
    database: "operational",
    up: `
      CREATE TABLE workflow_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual','scheduled','event','webhook','condition')),
        trigger_config TEXT NOT NULL DEFAULT '{}',
        steps TEXT NOT NULL,
        on_failure TEXT NOT NULL DEFAULT '{"type":"notify","channel":"telegram"}',
        max_duration_ms INTEGER NOT NULL DEFAULT 1800000,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX idx_workflow_defs_enabled ON workflow_definitions(enabled);
      CREATE INDEX idx_workflow_defs_trigger ON workflow_definitions(trigger_type);

      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL REFERENCES workflow_definitions(id),
        status TEXT NOT NULL CHECK(status IN ('pending','running','waiting','retrying','completed','failed','cancelled')),
        context TEXT NOT NULL DEFAULT '{}',
        current_step_id TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        error TEXT,
        trigger_payload TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
      CREATE INDEX idx_workflow_runs_def ON workflow_runs(definition_id);

      CREATE TABLE workflow_step_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        step_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),
        output TEXT,
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER,
        completed_at INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_step_results_run ON workflow_step_results(run_id);
      CREATE INDEX idx_step_results_status ON workflow_step_results(run_id, status);
    `,
    down: `
      DROP INDEX IF EXISTS idx_step_results_status;
      DROP INDEX IF EXISTS idx_step_results_run;
      DROP TABLE IF EXISTS workflow_step_results;
      DROP INDEX IF EXISTS idx_workflow_runs_def;
      DROP INDEX IF EXISTS idx_workflow_runs_status;
      DROP TABLE IF EXISTS workflow_runs;
      DROP INDEX IF EXISTS idx_workflow_defs_trigger;
      DROP INDEX IF EXISTS idx_workflow_defs_enabled;
      DROP TABLE IF EXISTS workflow_definitions;
    `,
  },
  {
    version: 16,
    name: "add_scheduled_tasks_timezone",
    database: "operational",
    up: `
      ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT;
    `,
    down: `
      ALTER TABLE scheduled_tasks DROP COLUMN timezone;
    `,
  },
];
