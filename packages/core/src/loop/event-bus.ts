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
import type { Logger } from "../logging/logger.ts";
import {
  DEFAULT_MAX_PENDING_EVENTS,
  type EventRow,
  MAX_PAYLOAD_SIZE,
  MAX_REPLAY_BATCH_SIZE,
  MAX_RETRIES,
  MAX_RETRIES_BY_TYPE,
  rowToEvent,
} from "./event-utils.ts";

type EventHandler = (event: BusEvent) => void | Promise<void>;

export interface EventBusOptions {
  /** Maximum pending (unprocessed) events before backpressure drops low-priority events. Default: 1000. */
  readonly maxPendingEvents?: number;
}

export class EventBus {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly subscribers: Map<EventType | "*", Set<EventHandler>>;
  private readonly maxPendingEvents: number;

  constructor(db: Database, logger: Logger, options?: EventBusOptions) {
    this.db = db;
    this.logger = logger;
    this.subscribers = new Map();
    this.maxPendingEvents = options?.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
  }

  /** Publish an event. Persists to SQLite, then notifies in-memory subscribers.
   *  Applies backpressure: when the pending queue exceeds maxPendingEvents,
   *  'normal' and 'low' priority events are dropped. 'critical' and 'high'
   *  priority events are never dropped. */
  publish<T>(
    type: EventType,
    payload: T,
    options?: { priority?: EventPriority; source?: string },
  ): Result<BusEvent<T>, EidolonError> {
    const id = randomUUID();
    const priority = options?.priority ?? "normal";
    const source = options?.source ?? "system";
    const timestamp = Date.now();

    // Backpressure: drop low-priority events when queue is overloaded
    if (priority !== "critical" && priority !== "high") {
      const countResult = this.pendingCount();
      if (countResult.ok && countResult.value >= this.maxPendingEvents) {
        this.logger.warn(
          "event-bus",
          `Backpressure: dropping ${priority} event ${type} (queue depth: ${countResult.value}, max: ${this.maxPendingEvents})`,
        );
        return Err(
          createError(
            ErrorCode.EVENT_BUS_ERROR,
            `Backpressure: event dropped (queue depth ${countResult.value} >= max ${this.maxPendingEvents})`,
          ),
        );
      }
    }

    const payloadJson = JSON.stringify(payload);

    if (payloadJson.length > MAX_PAYLOAD_SIZE) {
      return Err(
        createError(
          ErrorCode.EVENT_BUS_ERROR,
          `Payload too large (${payloadJson.length} bytes, max ${MAX_PAYLOAD_SIZE}) for event: ${type}`,
        ),
      );
    }

    // ERR-005: Persist with retry on transient SQLite errors (e.g. SQLITE_BUSY).
    // Note: the SQLite connection already sets PRAGMA busy_timeout (see connection.ts),
    // which provides kernel-level backoff for SQLITE_BUSY. The retry loop here is an
    // additional safety net; no explicit delay is needed between attempts because
    // busy_timeout already blocks internally before returning SQLITE_BUSY.
    const MAX_PERSIST_RETRIES = 3;
    let lastCause: unknown;
    for (let attempt = 0; attempt < MAX_PERSIST_RETRIES; attempt++) {
      try {
        this.db
          .query(
            "INSERT INTO events (id, type, priority, payload, source, timestamp, retry_count) VALUES (?, ?, ?, ?, ?, ?, 0)",
          )
          .run(id, type, priority, payloadJson, source, timestamp);
        lastCause = undefined;
        break;
      } catch (cause) {
        lastCause = cause;
        const msg = cause instanceof Error ? cause.message : String(cause);
        // Only retry on SQLITE_BUSY; other errors are non-transient
        if (!msg.includes("SQLITE_BUSY") || attempt === MAX_PERSIST_RETRIES - 1) {
          break;
        }
        this.logger.warn("event-bus", `Publish retry ${attempt + 1}/${MAX_PERSIST_RETRIES} for ${type}: ${msg}`);
        // Sync delay between retries to reduce contention pressure.
        // Uses Atomics.wait on a dummy buffer for a true sleep without spinning.
        // Supplements the kernel-level busy_timeout set in connection.ts.
        const delay = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(delay, 0, 0, 50);
      }
    }
    if (lastCause !== undefined) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, `Failed to persist event: ${type}`, lastCause));
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
      // Use per-type retry limits when available, otherwise fall back to global MAX_RETRIES
      const row = this.db.query("SELECT retry_count, type FROM events WHERE id = ?").get(eventId) as {
        retry_count: number;
        type: string;
      } | null;

      if (row) {
        const maxRetries = MAX_RETRIES_BY_TYPE[row.type] ?? MAX_RETRIES;
        if (row.retry_count >= maxRetries) {
          this.logger.warn(
            "event-bus",
            `Event ${eventId} (${row.type}) exceeded max retries (${maxRetries}), moving to dead letter`,
            {
              retryCount: row.retry_count,
              eventType: row.type,
            },
          );
          this.db.query("UPDATE events SET processed_at = ? WHERE id = ?").run(Date.now(), eventId);
          return Ok(undefined);
        }
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
   *  Awaits async handler completion before marking each event as processed.
   *  If a handler rejects, the event is deferred instead. */
  async replayUnprocessed(): Promise<Result<BusEvent[], EidolonError>> {
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
        try {
          await this.notifySubscribersAsync(event);
          // ERR-005: Mark each replayed event as processed only after handlers complete
          const markResult = this.markProcessed(event.id);
          if (!markResult.ok) {
            this.logger.error(
              "event-bus",
              `Failed to mark replayed event ${event.id} as processed: ${markResult.error.message}`,
              { eventId: event.id, type: event.type },
            );
          }
        } catch (handlerErr) {
          this.logger.error(
            "event-bus",
            `Handler threw during replay for event ${event.id} (${event.type}), deferring`,
            handlerErr,
          );
          this.defer(event.id);
        }
      }

      return Ok(events);
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, "Failed to replay unprocessed events", cause));
    }
  }

  /**
   * Drain all pending unclaimed events (non-blocking).
   * Atomically claims all returned events so subsequent drain() calls
   * will not return them again, preventing double-processing.
   */
  drain(): Result<BusEvent[], EidolonError> {
    try {
      const claimToken = randomUUID();
      let rows: EventRow[] = [];

      const drainFn = this.db.transaction(() => {
        rows = this.db
          .query(
            `SELECT * FROM events WHERE processed_at IS NULL AND claimed_at IS NULL
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

        if (rows.length > 0) {
          const ids = rows.map((r) => r.id);
          for (const id of ids) {
            this.db.query("UPDATE events SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL").run(claimToken, id);
          }
        }
      });

      drainFn();

      return Ok(rows.map((r) => rowToEvent(r, this.logger)));
    } catch (cause) {
      return Err(createError(ErrorCode.EVENT_BUS_ERROR, "Failed to drain events", cause));
    }
  }

  /**
   * SEC-L1: Dispose of all in-memory state (subscribers).
   * Should be called during graceful shutdown to release handler references
   * and prevent stale subscriptions from firing after shutdown begins.
   */
  dispose(): void {
    this.subscribers.clear();
    this.logger.debug("event-bus", "Disposed all subscribers");
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

  /**
   * Invoke a single handler safely and return a Promise that settles
   * when the handler completes (including async handlers).
   * Used by replayUnprocessed to await completion before marking processed.
   */
  private async safeInvokeAsync(handler: EventHandler, event: BusEvent, label: string): Promise<void> {
    try {
      await handler(event);
    } catch (err) {
      this.logger.error("event-bus", `${label} error for ${event.type}`, err);
      throw err; // Re-throw so replayUnprocessed can defer instead of marking processed
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

  /**
   * Notify in-memory subscribers and await all handler completions.
   * Used by replayUnprocessed to ensure handlers finish before marking processed.
   */
  private async notifySubscribersAsync(event: BusEvent): Promise<void> {
    const promises: Promise<void>[] = [];

    const typeHandlers = this.subscribers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        promises.push(this.safeInvokeAsync(handler, event, "Handler"));
      }
    }

    const wildcardHandlers = this.subscribers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        promises.push(this.safeInvokeAsync(handler, event, "Wildcard handler"));
      }
    }

    await Promise.all(promises);
  }
}
