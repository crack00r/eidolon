/**
 * EventBus with SQLite persistence.
 *
 * All inter-component communication flows through typed events.
 * Events are persisted to the `events` table in operational.db for crash recovery.
 * In-memory subscribers are notified synchronously after persistence.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { BusEvent, EidolonError, EventPriority, EventType, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

type EventHandler = (event: BusEvent) => void | Promise<void>;

interface EventRow {
  id: string;
  type: string;
  priority: string;
  payload: string;
  source: string;
  timestamp: number;
  processed_at: number | null;
  retry_count: number;
}

const VALID_EVENT_TYPES = new Set<string>([
  "user:message",
  "user:voice",
  "user:approval",
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
  "gateway:client_connected",
  "gateway:client_disconnected",
]);
const VALID_PRIORITIES = new Set<string>(["critical", "high", "normal", "low"]);

function validateEnum<T extends string>(value: unknown, valid: Set<string>, fallback: T): T {
  return valid.has(String(value)) ? (String(value) as T) : fallback;
}

/** Prototype-pollution keys to strip from parsed JSON payloads. */
const POISON_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** Strip prototype-pollution keys from parsed JSON payloads. */
function sanitizePayload(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  for (const key of POISON_KEYS) {
    Reflect.deleteProperty(obj, key);
  }
  return obj;
}

function rowToEvent(row: EventRow): BusEvent {
  return {
    id: row.id,
    type: validateEnum<EventType>(row.type, VALID_EVENT_TYPES, "system:health_check"),
    priority: validateEnum<EventPriority>(row.priority, VALID_PRIORITIES, "normal"),
    payload: sanitizePayload(JSON.parse(row.payload)),
    source: row.source,
    timestamp: row.timestamp,
    ...(row.processed_at !== null ? { processedAt: row.processed_at } : {}),
  };
}

export class EventBus {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly subscribers: Map<EventType | "*", Set<EventHandler>>;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.subscribers = new Map();
  }

  /** Publish an event. Persists to SQLite, then notifies in-memory subscribers. */
  publish<T>(
    type: EventType,
    payload: T,
    options?: { priority?: EventPriority; source?: string },
  ): Result<BusEvent<T>, EidolonError> {
    const id = randomUUID();
    const priority = options?.priority ?? "normal";
    const source = options?.source ?? "system";
    const timestamp = Date.now();
    const payloadJson = JSON.stringify(payload);

    try {
      this.db
        .query(
          "INSERT INTO events (id, type, priority, payload, source, timestamp, retry_count) VALUES (?, ?, ?, ?, ?, ?, 0)",
        )
        .run(id, type, priority, payloadJson, source, timestamp);
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, `Failed to persist event: ${type}`, cause));
    }

    const event: BusEvent<T> = { id, type, priority, payload, source, timestamp };

    this.logger.debug("event-bus", `Published ${type}`, { id, priority });
    this.notifySubscribers(event);

    return Ok(event);
  }

  /** Subscribe to events of a specific type. Returns unsubscribe function. */
  subscribe(type: EventType, handler: EventHandler): () => void {
    let handlers = this.subscribers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(type, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.subscribers.delete(type);
      }
    };
  }

  /** Subscribe to ALL events. */
  subscribeAll(handler: EventHandler): () => void {
    let handlers = this.subscribers.get("*");
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set("*", handlers);
    }
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.subscribers.delete("*");
      }
    };
  }

  /** Dequeue the highest-priority unprocessed event. Returns null if empty. */
  dequeue(): Result<BusEvent | null, EidolonError> {
    try {
      const row = this.db
        .query(
          `SELECT * FROM events WHERE processed_at IS NULL
           ORDER BY
             CASE priority
               WHEN 'critical' THEN 0
               WHEN 'high' THEN 1
               WHEN 'normal' THEN 2
               WHEN 'low' THEN 3
             END,
             timestamp ASC
           LIMIT 1`,
        )
        .get() as EventRow | null;

      if (!row) {
        return Ok(null);
      }

      return Ok(rowToEvent(row));
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, "Failed to dequeue event", cause));
    }
  }

  /** Mark an event as processed. */
  markProcessed(eventId: string): Result<void, EidolonError> {
    try {
      this.db.query("UPDATE events SET processed_at = ? WHERE id = ?").run(Date.now(), eventId);
      this.logger.debug("event-bus", `Marked processed: ${eventId}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, `Failed to mark event processed: ${eventId}`, cause));
    }
  }

  /** Defer an event (increment retry count, keep unprocessed). */
  defer(eventId: string): Result<void, EidolonError> {
    try {
      this.db.query("UPDATE events SET retry_count = retry_count + 1 WHERE id = ?").run(eventId);
      this.logger.debug("event-bus", `Deferred event: ${eventId}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, `Failed to defer event: ${eventId}`, cause));
    }
  }

  /** Get count of unprocessed events. */
  pendingCount(): Result<number, EidolonError> {
    try {
      const row = this.db.query("SELECT COUNT(*) as count FROM events WHERE processed_at IS NULL").get() as {
        count: number;
      };
      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, "Failed to count pending events", cause));
    }
  }

  /** Replay all unprocessed events (for crash recovery). */
  replayUnprocessed(): Result<BusEvent[], EidolonError> {
    try {
      const rows = this.db
        .query(
          `SELECT * FROM events WHERE processed_at IS NULL
           ORDER BY
             CASE priority
               WHEN 'critical' THEN 0
               WHEN 'high' THEN 1
               WHEN 'normal' THEN 2
               WHEN 'low' THEN 3
             END,
             timestamp ASC
           LIMIT 1000`,
        )
        .all() as EventRow[];

      const events = rows.map(rowToEvent);
      this.logger.info("event-bus", `Replaying ${events.length} unprocessed events`);

      for (const event of events) {
        this.notifySubscribers(event);
      }

      return Ok(events);
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, "Failed to replay unprocessed events", cause));
    }
  }

  /** Drain all pending events (non-blocking). */
  drain(): Result<BusEvent[], EidolonError> {
    try {
      const rows = this.db
        .query(
          `SELECT * FROM events WHERE processed_at IS NULL
           ORDER BY
             CASE priority
               WHEN 'critical' THEN 0
               WHEN 'high' THEN 1
               WHEN 'normal' THEN 2
               WHEN 'low' THEN 3
             END,
             timestamp ASC
           LIMIT 1000`,
        )
        .all() as EventRow[];

      return Ok(rows.map(rowToEvent));
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, "Failed to drain events", cause));
    }
  }

  /** Notify in-memory subscribers (type-specific + wildcard). */
  private notifySubscribers(event: BusEvent): void {
    const typeHandlers = this.subscribers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          void handler(event);
        } catch (err) {
          this.logger.error("event-bus", `Handler error for ${event.type}`, err);
        }
      }
    }

    const wildcardHandlers = this.subscribers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          void handler(event);
        } catch (err) {
          this.logger.error("event-bus", `Wildcard handler error for ${event.type}`, err);
        }
      }
    }
  }
}
