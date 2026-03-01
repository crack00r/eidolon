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
  claimed_at: number | null;
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
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Maximum number of retries before an event is sent to the dead letter queue. */
const MAX_RETRIES = 10;

/** Maximum number of events returned in a single replay or drain operation. */
const MAX_REPLAY_BATCH_SIZE = 1000;

/** Maximum serialized payload size in bytes (1 MB). */
const MAX_PAYLOAD_SIZE = 1_048_576;

/**
 * Recursively strip prototype-pollution keys from parsed JSON payloads.
 * Handles nested objects and arrays to prevent deep pollution attacks.
 */
function sanitizePayload(value: unknown): unknown {
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

function rowToEvent(row: EventRow, logger?: Logger): BusEvent {
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

    if (payloadJson.length > MAX_PAYLOAD_SIZE) {
      return Err(
        createError(
          ErrorCode.EVENT_BUS_ERROR,
          `Payload too large (${payloadJson.length} bytes, max ${MAX_PAYLOAD_SIZE}) for event: ${type}`,
        ),
      );
    }

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

  /**
   * Atomically dequeue the highest-priority unprocessed event.
   * Uses a transaction to claim the event (set claimed_at) and select it
   * in one atomic operation, preventing double-dequeue in concurrent scenarios.
   */
  dequeue(): Result<BusEvent | null, EidolonError> {
    try {
      const claimToken = randomUUID();
      let row: EventRow | null = null;

      const dequeueFn = this.db.transaction(() => {
        // Find the first unprocessed+unclaimed row
        const candidate = this.db
          .query(
            `SELECT id FROM events
             WHERE processed_at IS NULL AND claimed_at IS NULL
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
          .get() as { id: string } | null;

        if (!candidate) return;

        // Atomically claim using unique token
        this.db
          .query("UPDATE events SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
          .run(claimToken, candidate.id);

        // SELECT the row we just claimed using the unique token
        row = this.db
          .query("SELECT * FROM events WHERE id = ? AND claimed_at = ? AND processed_at IS NULL LIMIT 1")
          .get(candidate.id, claimToken) as EventRow | null;
      });

      dequeueFn();

      if (!row) {
        return Ok(null);
      }

      return Ok(rowToEvent(row, this.logger));
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

  /**
   * Defer an event (increment retry count, unclaim, keep unprocessed).
   * If retry_count reaches MAX_RETRIES, the event is marked processed
   * as a dead letter to prevent infinite retry loops.
   */
  defer(eventId: string): Result<void, EidolonError> {
    try {
      // Unclaim so the event can be re-dequeued, and increment retry count
      this.db.query("UPDATE events SET retry_count = retry_count + 1, claimed_at = NULL WHERE id = ?").run(eventId);

      // Check if max retries exceeded -> dead letter
      const row = this.db.query("SELECT retry_count FROM events WHERE id = ?").get(eventId) as {
        retry_count: number;
      } | null;

      if (row && row.retry_count >= MAX_RETRIES) {
        this.logger.warn("event-bus", `Event ${eventId} exceeded max retries (${MAX_RETRIES}), moving to dead letter`, {
          retryCount: row.retry_count,
        });
        this.db.query("UPDATE events SET processed_at = ? WHERE id = ?").run(Date.now(), eventId);
        return Ok(undefined);
      }

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

  /** Replay all unprocessed events (for crash recovery).
   *  After notifying subscribers, each replayed event is marked as processed
   *  to prevent infinite replay on restart. */
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
           LIMIT ?`,
        )
        .all(MAX_REPLAY_BATCH_SIZE) as EventRow[];

      const events = rows.map((r) => rowToEvent(r, this.logger));
      this.logger.info("event-bus", `Replaying ${events.length} unprocessed events`);

      if (events.length === MAX_REPLAY_BATCH_SIZE) {
        this.logger.warn(
          "event-bus",
          `Replay hit limit (${MAX_REPLAY_BATCH_SIZE}) -- there may be more unprocessed events remaining`,
        );
      }

      for (const event of events) {
        this.notifySubscribers(event);
        // Mark each replayed event as processed to prevent infinite replay
        this.markProcessed(event.id);
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
            LIMIT ?`,
        )
        .all(MAX_REPLAY_BATCH_SIZE) as EventRow[];

      return Ok(rows.map((r) => rowToEvent(r, this.logger)));
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, "Failed to drain events", cause));
    }
  }

  /** Invoke a single handler safely, catching both sync throws and async rejections. */
  private safeInvoke(handler: EventHandler, event: BusEvent, label: string): void {
    try {
      const result = handler(event);
      // If the handler returns a Promise, catch async rejections
      if (result && typeof result === "object" && "catch" in result && typeof result.catch === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          this.logger.error("event-bus", `Async ${label} error for ${event.type}`, err);
        });
      }
    } catch (err) {
      this.logger.error("event-bus", `${label} error for ${event.type}`, err);
    }
  }

  /** Notify in-memory subscribers (type-specific + wildcard). */
  private notifySubscribers(event: BusEvent): void {
    const typeHandlers = this.subscribers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        this.safeInvoke(handler, event, "Handler");
      }
    }

    const wildcardHandlers = this.subscribers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        this.safeInvoke(handler, event, "Wildcard handler");
      }
    }
  }
}
