/**
 * CalendarManager -- manages calendar providers, event caching, sync,
 * reminder notifications, and schedule context injection.
 *
 * Events are cached in the `calendar_events` table in operational.db.
 * Publishes calendar-related events to the EventBus.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarProvider,
  CalendarProviderType,
  CalendarSyncResult,
  EidolonError,
  Result,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface CalendarEventRow {
  id: string;
  calendar_id: string;
  provider: string;
  title: string;
  description: string | null;
  location: string | null;
  start_time: number;
  end_time: number;
  all_day: number;
  recurrence: string | null;
  reminders: string;
  raw_data: string | null;
  sync_token: string | null;
  synced_at: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Conflict descriptor returned by findConflicts()
// ---------------------------------------------------------------------------

export interface ConflictInfo {
  readonly eventIds: readonly string[];
  readonly titles: readonly string[];
  readonly overlapStart: number;
  readonly overlapEnd: number;
}

// ---------------------------------------------------------------------------
// CalendarManager
// ---------------------------------------------------------------------------

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
    if (providerName) {
      return this.syncProvider(providerName);
    }

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

    const combined: CalendarSyncResult = {
      added: totalAdded,
      updated: totalUpdated,
      deleted: totalDeleted,
    };

    this.eventBus.publish("calendar:sync_completed", combined, {
      source: "calendar",
      priority: "low",
    });

    return Ok(combined);
  }

  /** Sync a specific provider by ID. */
  private async syncProvider(providerId: string): Promise<Result<CalendarSyncResult, EidolonError>> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return Err(
        createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Provider not found: ${providerId}`),
      );
    }

    // Get the last sync token for this provider
    const lastToken = this.getLastSyncToken(providerId);

    const syncResult = await provider.sync(lastToken ?? undefined);
    if (!syncResult.ok) {
      this.logger.warn("calendar", `Sync failed for ${providerId}: ${syncResult.error.message}`);
      return syncResult;
    }

    this.logger.info("calendar", `Synced ${providerId}: +${syncResult.value.added} ~${syncResult.value.updated} -${syncResult.value.deleted}`);

    // Store the new sync token if provided
    if (syncResult.value.syncToken) {
      this.storeSyncToken(providerId, syncResult.value.syncToken);
    }

    return syncResult;
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
  createEvent(
    event: Omit<CalendarEvent, "id" | "syncedAt">,
  ): Result<CalendarEvent, EidolonError> {
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
    this.checkConflicts(fullEvent);

    return Ok(fullEvent);
  }

  /** Delete an event from the local cache. */
  deleteEvent(eventId: string): Result<void, EidolonError> {
    try {
      const existing = this.db
        .query("SELECT id FROM calendar_events WHERE id = ?")
        .get(eventId) as { id: string } | null;

      if (!existing) {
        return Err(createError(ErrorCode.CALENDAR_EVENT_NOT_FOUND, `Event not found: ${eventId}`));
      }

      this.db.query("DELETE FROM calendar_events WHERE id = ?").run(eventId);
      this.logger.debug("calendar", `Deleted event: ${eventId}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to delete calendar event", cause));
    }
  }

  /**
   * Insert or update an event in the local cache.
   * Used by both manual creation and provider sync.
   */
  upsertEvent(event: CalendarEvent): Result<CalendarEvent, EidolonError> {
    try {
      const remindersJson = JSON.stringify(event.reminders);
      this.db
        .query(
          `INSERT INTO calendar_events
             (id, calendar_id, provider, title, description, location,
              start_time, end_time, all_day, recurrence, reminders,
              synced_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             description = excluded.description,
             location = excluded.location,
             start_time = excluded.start_time,
             end_time = excluded.end_time,
             all_day = excluded.all_day,
             recurrence = excluded.recurrence,
             reminders = excluded.reminders,
             synced_at = excluded.synced_at`,
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
          remindersJson,
          event.syncedAt,
          Date.now(),
        );
      return Ok(event);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to upsert calendar event", cause));
    }
  }

  /**
   * Generate schedule context for injection into MEMORY.md.
   * Returns a formatted string of today's and upcoming events.
   */
  injectScheduleContext(): Result<string, EidolonError> {
    if (!this.config.injection.enabled) {
      return Ok("");
    }

    const now = Date.now();
    const daysAheadMs = this.config.injection.daysAhead * 86_400_000;
    const end = now + daysAheadMs;

    const eventsResult = this.listEvents(now, end);
    if (!eventsResult.ok) return eventsResult;

    const events = eventsResult.value;
    if (events.length === 0) {
      return Ok("");
    }

    const lines: string[] = ["## Schedule"];

    // Group events by day
    const byDay = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const dateKey = new Date(event.startTime).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const dayEvents = byDay.get(dateKey) ?? [];
      dayEvents.push(event);
      byDay.set(dateKey, dayEvents);
    }

    for (const [day, dayEvents] of byDay) {
      lines.push(`### ${day}`);
      for (const event of dayEvents) {
        if (event.allDay) {
          lines.push(`- [All Day] ${event.title}${event.location ? ` @ ${event.location}` : ""}`);
        } else {
          const startStr = new Date(event.startTime).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          const endStr = new Date(event.endTime).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          lines.push(
            `- ${startStr}-${endStr} ${event.title}${event.location ? ` @ ${event.location}` : ""}`,
          );
        }
      }
    }

    return Ok(lines.join("\n"));
  }

  /**
   * Check upcoming events and publish reminder events.
   * Called periodically by the daemon.
   */
  checkReminders(): void {
    const now = Date.now();
    const maxLookahead = Math.max(...(this.config.reminders.defaultMinutesBefore ?? [60]));
    const end = now + maxLookahead * 60_000;

    const eventsResult = this.listEvents(now, end);
    if (!eventsResult.ok) return;

    for (const event of eventsResult.value) {
      const minutesUntil = Math.floor((event.startTime - now) / 60_000);
      const reminderMinutes = this.config.reminders.defaultMinutesBefore ?? [15, 60];

      for (const reminderBefore of reminderMinutes) {
        // Fire reminder if we are within 1 minute of the reminder time
        if (Math.abs(minutesUntil - reminderBefore) < 1) {
          this.eventBus.publish(
            "calendar:event_upcoming",
            {
              eventId: event.id,
              title: event.title,
              startTime: event.startTime,
              minutesBefore: reminderBefore,
            },
            { source: "calendar", priority: "high" },
          );
        }
      }
    }
  }

  /**
   * Find all scheduling conflicts (overlapping non-all-day events) within a
   * time range.  Returns an array of conflict descriptors.
   */
  findConflicts(
    start: number,
    end: number,
  ): Result<ConflictInfo[], EidolonError> {
    const eventsResult = this.listEvents(start, end);
    if (!eventsResult.ok) return eventsResult;

    const events = eventsResult.value.filter((e) => !e.allDay);
    const conflicts: ConflictInfo[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const a = events[i]!;
        const b = events[j]!;
        // Two events overlap when a.start < b.end AND b.start < a.end
        if (a.startTime < b.endTime && b.startTime < a.endTime) {
          const key = [a.id, b.id].sort().join(":");
          if (seen.has(key)) continue;
          seen.add(key);

          conflicts.push({
            eventIds: [a.id, b.id],
            titles: [a.title, b.title],
            overlapStart: Math.max(a.startTime, b.startTime),
            overlapEnd: Math.min(a.endTime, b.endTime),
          });
        }
      }
    }

    return Ok(conflicts);
  }

  /** Detect overlapping events and publish conflict events. */
  private checkConflicts(newEvent: CalendarEvent): void {
    if (newEvent.allDay) return;

    const overlapping = this.listEvents(newEvent.startTime, newEvent.endTime);
    if (!overlapping.ok) return;

    // Filter out the event itself and all-day events
    const conflicts = overlapping.value.filter(
      (e) => e.id !== newEvent.id && !e.allDay,
    );

    if (conflicts.length > 0) {
      const allEvents = [newEvent, ...conflicts];
      const overlapStart = Math.max(...allEvents.map((e) => e.startTime));
      const overlapEnd = Math.min(...allEvents.map((e) => e.endTime));

      this.eventBus.publish(
        "calendar:conflict_detected",
        {
          eventIds: allEvents.map((e) => e.id),
          titles: allEvents.map((e) => e.title),
          overlapStart,
          overlapEnd,
        },
        { source: "calendar", priority: "normal" },
      );
    }
  }

  /** Get the last sync token for a provider from loop_state. */
  private getLastSyncToken(providerId: string): string | null {
    try {
      const row = this.db
        .query("SELECT value FROM loop_state WHERE key = ?")
        .get(`calendar_sync_token:${providerId}`) as { value: string } | null;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Store a sync token for a provider in loop_state. */
  private storeSyncToken(providerId: string, token: string): void {
    try {
      this.db
        .query(
          `INSERT INTO loop_state (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(`calendar_sync_token:${providerId}`, token, Date.now());
    } catch (err) {
      this.logger.warn("calendar", `Failed to store sync token for ${providerId}`, {
        error: String(err),
      });
    }
  }

  /** Stop all sync intervals and disconnect providers. */
  async dispose(): Promise<void> {
    for (const [name, interval] of this.syncIntervals) {
      clearInterval(interval);
      this.logger.debug("calendar", `Stopped sync interval for ${name}`);
    }
    this.syncIntervals.clear();

    for (const provider of this.providers.values()) {
      await provider.disconnect();
    }
    this.providers.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToCalendarEvent(row: CalendarEventRow): CalendarEvent {
  let reminders: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.reminders);
    if (Array.isArray(parsed)) {
      reminders = parsed.filter((v): v is number => typeof v === "number");
    }
  } catch {
    // Invalid JSON, use default empty array
  }

  return {
    id: row.id,
    calendarId: row.calendar_id,
    title: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    startTime: row.start_time,
    endTime: row.end_time,
    allDay: row.all_day === 1,
    recurrence: row.recurrence ?? undefined,
    reminders,
    source: row.provider as CalendarProviderType,
    syncedAt: row.synced_at,
  };
}
