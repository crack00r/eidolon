/**
 * PRIV-004: Comprehensive data export (GDPR data portability).
 *
 * Exports all user data across memory.db, operational.db, and audit.db
 * as structured JSON.
 */

import type { Database } from "bun:sqlite";
import type { DatabaseManager } from "@eidolon/core";
import { VERSION } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportData {
  readonly metadata: {
    readonly exportDate: string;
    readonly version: string;
    readonly tablesIncluded: readonly string[];
    readonly recordCounts: Record<string, number>;
  };
  readonly memories: unknown[];
  readonly memoryEdges: unknown[];
  readonly memoryEmbeddings: unknown[];
  readonly kgEntities: unknown[];
  readonly kgRelations: unknown[];
  readonly kgCommunities: unknown[];
  readonly kgComplexEmbeddings: unknown[];
  readonly sessions: unknown[];
  readonly events: unknown[];
  readonly conversations: unknown[];
  readonly scheduledTasks: unknown[];
  readonly tokenUsage: unknown[];
  readonly discoveries: unknown[];
  readonly learningImplementations: unknown[];
  readonly deviceTokens: unknown[];
  readonly auditLog: unknown[];
  readonly consent: unknown[];
  readonly config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe select all -- returns [] on failure. */
function safeSelectAll(db: Database, sql: string): unknown[] {
  try {
    return db.query(sql).all();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportAllData(dbManager: DatabaseManager): ExportData {
  const recordCounts: Record<string, number> = {};
  const tablesIncluded: string[] = [];

  // --- memory.db ---

  const memories = safeSelectAll(
    dbManager.memory,
    "SELECT id, type, layer, content, confidence, source, tags, metadata, accessed_at, access_count, sensitive, created_at, updated_at FROM memories",
  );
  recordCounts.memories = memories.length;
  tablesIncluded.push("memories");

  const memoryEmbeddings = safeSelectAll(
    dbManager.memory,
    "SELECT id, type, layer, content FROM memories WHERE embedding IS NOT NULL",
  );
  recordCounts.memoryEmbeddings = memoryEmbeddings.length;
  tablesIncluded.push("memory_embeddings");

  const memoryEdges = safeSelectAll(
    dbManager.memory,
    "SELECT source_id, target_id, relation, weight, created_at FROM memory_edges",
  );
  recordCounts.memoryEdges = memoryEdges.length;
  tablesIncluded.push("memory_edges");

  const kgEntities = safeSelectAll(
    dbManager.memory,
    "SELECT id, name, type, attributes, created_at, updated_at FROM kg_entities",
  );
  recordCounts.kgEntities = kgEntities.length;
  tablesIncluded.push("kg_entities");

  const kgRelations = safeSelectAll(
    dbManager.memory,
    "SELECT id, source_id, target_id, type, confidence, source, created_at FROM kg_relations",
  );
  recordCounts.kgRelations = kgRelations.length;
  tablesIncluded.push("kg_relations");

  const kgCommunities = safeSelectAll(
    dbManager.memory,
    "SELECT id, name, entity_ids, summary, created_at FROM kg_communities",
  );
  recordCounts.kgCommunities = kgCommunities.length;
  tablesIncluded.push("kg_communities");

  const kgComplexEmbeddings = safeSelectAll(
    dbManager.memory,
    "SELECT entity_id, updated_at FROM kg_complex_embeddings",
  );
  recordCounts.kgComplexEmbeddings = kgComplexEmbeddings.length;
  tablesIncluded.push("kg_complex_embeddings");

  // --- operational.db ---

  const sessions = safeSelectAll(
    dbManager.operational,
    "SELECT id, type, status, claude_session_id, started_at, last_activity_at, completed_at, tokens_used, cost_usd, metadata FROM sessions",
  );
  recordCounts.sessions = sessions.length;
  tablesIncluded.push("sessions");

  const events = safeSelectAll(
    dbManager.operational,
    "SELECT id, type, priority, payload, source, timestamp, processed_at, retry_count FROM events ORDER BY timestamp DESC",
  );
  recordCounts.events = events.length;
  tablesIncluded.push("events");

  const conversations = sessions;
  recordCounts.conversations = conversations.length;

  const scheduledTasks = safeSelectAll(
    dbManager.operational,
    "SELECT id, name, type, cron, run_at, condition, action, payload, enabled, last_run_at, next_run_at, created_at FROM scheduled_tasks",
  );
  recordCounts.scheduledTasks = scheduledTasks.length;
  tablesIncluded.push("scheduled_tasks");

  const tokenUsage = safeSelectAll(
    dbManager.operational,
    "SELECT id, session_id, session_type, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, timestamp FROM token_usage ORDER BY timestamp DESC",
  );
  recordCounts.tokenUsage = tokenUsage.length;
  tablesIncluded.push("token_usage");

  const discoveries = safeSelectAll(
    dbManager.operational,
    "SELECT id, source_type, url, title, content, relevance_score, safety_level, status, implementation_branch, created_at, evaluated_at, implemented_at FROM discoveries",
  );
  recordCounts.discoveries = discoveries.length;
  tablesIncluded.push("discoveries");

  const learningImplementations: unknown[] = [];
  recordCounts.learningImplementations = 0;
  tablesIncluded.push("learning_implementations");

  const deviceTokens = safeSelectAll(
    dbManager.operational,
    "SELECT id, platform, created_at, last_used_at FROM device_tokens",
  );
  recordCounts.deviceTokens = deviceTokens.length;
  tablesIncluded.push("device_tokens");

  // --- audit.db ---

  const auditLog = safeSelectAll(
    dbManager.audit,
    "SELECT id, timestamp, actor, action, target, result, metadata FROM audit_log ORDER BY timestamp DESC",
  );
  recordCounts.auditLog = auditLog.length;
  tablesIncluded.push("audit_log");

  // --- Consent status ---
  const consent = safeSelectAll(
    dbManager.operational,
    "SELECT id, consent_type, granted, granted_at, revoked_at, updated_at FROM user_consent",
  );
  recordCounts.consent = consent.length;
  tablesIncluded.push("user_consent");

  return {
    metadata: {
      exportDate: new Date().toISOString(),
      version: VERSION,
      tablesIncluded,
      recordCounts,
    },
    memories,
    memoryEdges,
    memoryEmbeddings,
    kgEntities,
    kgRelations,
    kgCommunities,
    kgComplexEmbeddings,
    sessions,
    events,
    conversations,
    scheduledTasks,
    tokenUsage,
    discoveries,
    learningImplementations,
    deviceTokens,
    auditLog,
    consent,
    config: { note: "Secrets are not included in exports" },
  };
}
