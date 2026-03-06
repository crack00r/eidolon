/**
 * CalendarManager -- provider management, event caching, sync, reminders,
 * and schedule context injection.  Utility helpers in calendar-utils.ts.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarProvider,
  CalendarSyncResult,
  EidolonError,
  Result,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import {
  buildScheduleContext,
  type CalendarEventRow,
  type ConflictInfo,
  checkConflictsForEvent,
  checkReminders as checkRemindersFn,
  findConflicts as findConflictsFn,
  rowToCalendarEvent,
} from "./calendar-utils.ts";

// Re-export ConflictInfo so barrel export in index.ts keeps working
export type { ConflictInfo } from "./calendar-utils.ts";

export interface CalendarManagerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly config: CalendarConfig;
}

export class CalendarManager {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly config: CalendarConfig;
  private readonly providers: Map<string, CalendarProvider> = new Map();
  private syncIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(deps: CalendarManagerDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
  }

  /** Register a calendar provider. */
  registerProvider(provider: CalendarProvider): void {
    this.providers.set(provider.id, provider);
    this.logger.info("calendar", `Registered provider: ${provider.name} (${provider.id})`);
  }

  /** Connect all registered providers and start sync intervals. */
  async initialize(): Promise<Result<void, EidolonError>> {
    if (!this.config.enabled) {
      this.logger.info("calendar", "Calendar integration disabled");
      return Ok(undefined);
    }

    for (const provider of this.providers.values()) {
      const result = await provider.connect();
      if (!result.ok) {
        this.logger.warn("calendar", `Failed to connect provider ${provider.id}: ${result.error.message}`);
        continue;
      }
      this.logger.info("calendar", `Connected provider: ${provider.name}`);
    }

    // Start periodic sync for each configured provider
    for (const providerConfig of this.config.providers) {
      const intervalMs = providerConfig.syncIntervalMinutes * 60_000;
      const interval = setInterval(() => {
        void this.syncProvider(providerConfig.name);
      }, intervalMs);
      this.syncIntervals.set(providerConfig.name, interval);
    }

    return Ok(undefined);
  }

  /** Sync all providers or a specific provider. */
  async sync(providerName?: string): Promise<Result<CalendarSyncResult, EidolonError>> {
    if (providerName) return this.syncProvider(providerName);

    let totalAdded = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    for (const provider of this.providers.values()) {
      const result = await this.syncProvider(provider.id);
      if (result.ok) {
        totalAdded += result.value.added;
        totalUpdated += result.value.updated;
        totalDeleted += result.value.deleted;
      }
    }
    const combined: CalendarSyncResult = { added: totalAdded, updated: totalUpdated, deleted: totalDeleted };
    this.eventBus.publish("calendar:sync_completed", combined, { source: "calendar", priority: "low" });
    return Ok(combined);
  }

  /** List events within a time range from the local cache. */
  listEvents(start: number, end: number): Result<CalendarEvent[], EidolonError> {
    try {
      const rows = this.db
        .query(
          `SELECT * FROM calendar_events
           WHERE start_time < ? AND end_time > ?
           ORDER BY start_time ASC`,
        )
        .all(end, start) as CalendarEventRow[];

      return Ok(rows.map(rowToCalendarEvent));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list calendar events", cause));
    }
  }

  /** Get upcoming events within the next N hours. */
  getUpcoming(hours: number): Result<CalendarEvent[], EidolonError> {
    const now = Date.now();
    const end = now + hours * 3_600_000;
    return this.listEvents(now, end);
  }

  /** Create a manual event (not from a provider sync). */
  createEvent(event: Omit<CalendarEvent, "id" | "syncedAt">): Result<CalendarEvent, EidolonError> {
    const id = randomUUID();
    const syncedAt = Date.now();
    const fullEvent: CalendarEvent = { ...event, id, syncedAt };

    const insertResult = this.upsertEvent(fullEvent);
    if (!insertResult.ok) return insertResult;

    this.eventBus.publish(
      "calendar:event_created",
      {
        eventId: id,
        calendarId: event.calendarId,
        title: event.title,
        startTime: event.startTime,
        endTime: event.endTime,
        source: event.source,
      },
      { source: "calendar", priority: "normal" },
    );

    // Check for conflicts
    const overlapping = this.listEvents(fullEvent.startTime, fullEvent.endTime);
    if (overlapping.ok) {
      checkConflictsForEvent(fullEvent, overlapping.value, this.eventBus);
    }

    return Ok(fullEvent);
  }

  /** Delete an event from the local cache. */
  deleteEvent(eventId: string): Result<void, EidolonError> {
    try {
      const existing = this.db.query("SELECT id FROM calendar_events WHERE id = ?").get(eventId);
      if (!existing) return Err(createError(ErrorCode.CALENDAR_EVENT_NOT_FOUND, `Event not found: ${eventId}`));
      this.db.query("DELETE FROM calendar_events WHERE id = ?").run(eventId);
      this.logger.debug("calendar", `Deleted event: ${eventId}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to delete calendar event", cause));
    }
  }

  /** Insert or update an event in the local cache. */
  upsertEvent(event: CalendarEvent): Result<CalendarEvent, EidolonError> {
    try {
      this.db
        .query(
          `INSERT INTO calendar_events (id,calendar_id,provider,title,description,location,
             start_time,end_time,all_day,recurrence,reminders,synced_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
             location=excluded.location,start_time=excluded.start_time,end_time=excluded.end_time,
             all_day=excluded.all_day,recurrence=excluded.recurrence,reminders=excluded.reminders,
             synced_at=excluded.synced_at`,
        )
        .run(
          event.id,
          event.calendarId,
          event.source,
          event.title,
          event.description ?? null,
          event.location ?? null,
          event.startTime,
          event.endTime,
          event.allDay ? 1 : 0,
          event.recurrence ?? null,
          JSON.stringify(event.reminders),
          event.syncedAt,
          Date.now(),
        );
      return Ok(event);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to upsert calendar event", cause));
    }
  }

  /** Generate schedule context for injection into MEMORY.md. */
  injectScheduleContext(): Result<string, EidolonError> {
    if (!this.config.injection.enabled) return Ok("");
    const now = Date.now();
    const end = now + this.config.injection.daysAhead * 86_400_000;
    const eventsResult = this.listEvents(now, end);
    if (!eventsResult.ok) return eventsResult;
    return Ok(buildScheduleContext(eventsResult.value));
  }

  /** Check upcoming events and publish reminder events. */
  checkReminders(): void {
    const maxLookahead = Math.max(...(this.config.reminders.defaultMinutesBefore ?? [60]));
    const now = Date.now();
    const end = now + maxLookahead * 60_000;

    const eventsResult = this.listEvents(now, end);
    if (!eventsResult.ok) return;

    checkRemindersFn(eventsResult.value, this.config, this.eventBus);
  }

  /** Find all scheduling conflicts within a time range. */
  findConflicts(start: number, end: number): Result<ConflictInfo[], EidolonError> {
    const eventsResult = this.listEvents(start, end);
    if (!eventsResult.ok) return eventsResult;

    return Ok(findConflictsFn(eventsResult.value));
  }

  /** Stop all sync intervals and disconnect providers. */
  async dispose(): Promise<void> {
    for (const [_name, interval] of this.syncIntervals) clearInterval(interval);
    this.syncIntervals.clear();
    for (const provider of this.providers.values()) await provider.disconnect();
    this.providers.clear();
  }

  private async syncProvider(providerId: string): Promise<Result<CalendarSyncResult, EidolonError>> {
    const provider = this.providers.get(providerId);
    if (!provider) return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Provider not found: ${providerId}`));

    const syncResult = await provider.sync(this.getLastSyncToken(providerId) ?? undefined);
    if (!syncResult.ok) {
      this.logger.warn("calendar", `Sync failed for ${providerId}: ${syncResult.error.message}`);
      return syncResult;
    }
    this.logger.info(
      "calendar",
      `Synced ${providerId}: +${syncResult.value.added} ~${syncResult.value.updated} -${syncResult.value.deleted}`,
    );
    if (syncResult.value.syncToken) this.storeSyncToken(providerId, syncResult.value.syncToken);
    return syncResult;
  }

  private getLastSyncToken(providerId: string): string | null {
    try {
      const row = this.db
        .query("SELECT value FROM loop_state WHERE key = ?")
        .get(`calendar_sync_token:${providerId}`) as { value: string } | null;
      return row?.value ?? null;
    } catch {
      // Intentional: DB failure returns null sync token, triggering full sync
      return null;
    }
  }

  private storeSyncToken(providerId: string, token: string): void {
    try {
      this.db
        .query(
          `INSERT INTO loop_state (key,value,updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
        )
        .run(`calendar_sync_token:${providerId}`, token, Date.now());
    } catch (err) {
      this.logger.warn("calendar", `Failed to store sync token for ${providerId}`, { error: String(err) });
    }
  }
}
