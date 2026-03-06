/**
 * Event bus utility functions: validation, sanitization, row conversion.
 *
 * Extracted from event-bus.ts to keep the main EventBus class under 300 lines.
 */

import type { BusEvent, EventPriority, EventType } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventRow {
  id: string;
  type: string;
  priority: string;
  payload: string;
  source: string;
  timestamp: number;
  processed_at: number | null;
  claimed_at: number | null;
  retry_count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VALID_EVENT_TYPES = new Set<string>([
  "user:message",
  "user:voice",
  "user:approval",
  "user:feedback",
  "system:startup",
  "system:shutdown",
  "system:health_check",
  "system:config_changed",
  "memory:extracted",
  "memory:dream_start",
  "memory:dream_complete",
  "learning:discovery",
  "learning:approved",
  "learning:rejected",
  "learning:implemented",
  "session:started",
  "session:completed",
  "session:failed",
  "session:budget_warning",
  "channel:connected",
  "channel:disconnected",
  "channel:error",
  "scheduler:task_due",
  "scheduler:automation_due",
  "gateway:client_connected",
  "gateway:client_disconnected",
  "gateway:client_error_report",
  "digest:generate",
  "digest:delivered",
  "approval:requested",
  "approval:timeout",
  "approval:escalated",
  "webhook:received",
  "research:started",
  "research:completed",
  "research:failed",
  "calendar:event_upcoming",
  "calendar:event_created",
  "calendar:conflict_detected",
  "calendar:sync_completed",
  "ha:state_changed",
  "ha:anomaly_detected",
  "ha:scene_executed",
  "plugin:loaded",
  "plugin:started",
  "plugin:stopped",
  "plugin:error",
  "llm:provider_available",
  "llm:provider_unavailable",
]);

export const VALID_PRIORITIES = new Set<string>(["critical", "high", "normal", "low"]);

/** Maximum number of retries before an event is sent to the dead letter queue. */
export const MAX_RETRIES = 10;

/** Maximum number of events returned in a single replay or drain operation. */
export const MAX_REPLAY_BATCH_SIZE = 1000;

/** Maximum serialized payload size in bytes (1 MB). */
export const MAX_PAYLOAD_SIZE = 1_048_576;

/** Default maximum pending events before backpressure kicks in. */
export const DEFAULT_MAX_PENDING_EVENTS = 1000;

// ---------------------------------------------------------------------------
// Prototype-pollution protection
// ---------------------------------------------------------------------------

/** Prototype-pollution keys to strip from parsed JSON payloads. */
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Recursively strip prototype-pollution keys from parsed JSON payloads.
 * Handles nested objects and arrays to prevent deep pollution attacks.
 */
export function sanitizePayload(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizePayload);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (POISON_KEYS.has(key)) {
      Reflect.deleteProperty(obj, key);
    } else {
      obj[key] = sanitizePayload(obj[key]);
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateEnum<T extends string>(value: unknown, valid: Set<string>, fallback: T): T {
  return valid.has(String(value)) ? (String(value) as T) : fallback;
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

export function rowToEvent(row: EventRow, logger?: Logger): BusEvent {
  let payload: unknown;
  try {
    payload = sanitizePayload(JSON.parse(row.payload));
  } catch {
    if (logger) {
      logger.warn("event-bus", `Corrupted event payload for event ${row.id}, using fallback`, {
        id: row.id,
      });
    }
    payload = { _corrupted: true, raw: row.payload.slice(0, 200) };
  }
  return {
    id: row.id,
    type: validateEnum<EventType>(row.type, VALID_EVENT_TYPES, "system:health_check"),
    priority: validateEnum<EventPriority>(row.priority, VALID_PRIORITIES, "normal"),
    payload,
    source: row.source,
    timestamp: row.timestamp,
    ...(row.processed_at !== null ? { processedAt: row.processed_at } : {}),
  };
}
