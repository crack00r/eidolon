/**
 * Calendar utility functions: row conversion, schedule context injection,
 * reminder checking, and conflict detection.
 *
 * Extracted from manager.ts to keep CalendarManager under 300 lines.
 */

import type { CalendarConfig, CalendarEvent, CalendarProviderType } from "@eidolon/protocol";
import { z } from "zod";
import type { EventBus } from "../loop/event-bus.ts";

const CalendarProviderTypeSchema = z.enum(["google", "caldav", "manual"]);

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

export interface CalendarEventRow {
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
// Conflict descriptor
// ---------------------------------------------------------------------------

export interface ConflictInfo {
  readonly eventIds: readonly string[];
  readonly titles: readonly string[];
  readonly overlapStart: number;
  readonly overlapEnd: number;
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

export function rowToCalendarEvent(row: CalendarEventRow): CalendarEvent {
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
    source: CalendarProviderTypeSchema.catch("manual").parse(row.provider),
    syncedAt: row.synced_at,
  };
}

// ---------------------------------------------------------------------------
// Schedule context injection
// ---------------------------------------------------------------------------

/**
 * Generate schedule context for injection into MEMORY.md.
 * Returns a formatted string of today's and upcoming events.
 */
export function buildScheduleContext(events: readonly CalendarEvent[]): string {
  if (events.length === 0) return "";

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
        lines.push(`- ${startStr}-${endStr} ${event.title}${event.location ? ` @ ${event.location}` : ""}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reminder checking
// ---------------------------------------------------------------------------

/**
 * Track fired reminders to prevent duplicates across periodic calls.
 * Key: "eventId:minutesBefore:startTime", evicted when older than 2 hours.
 */
const firedReminders = new Set<string>();
const REMINDER_EVICTION_MS = 7_200_000;
let lastReminderEviction = 0;

/**
 * Check upcoming events and publish reminder events.
 * Called periodically by the daemon. Deduplicates to avoid firing the same reminder twice.
 */
export function checkReminders(events: readonly CalendarEvent[], config: CalendarConfig, eventBus: EventBus): void {
  const now = Date.now();
  const reminderMinutes = config.reminders.defaultMinutesBefore ?? [15, 60];

  // Periodically evict old entries to prevent unbounded growth
  if (now - lastReminderEviction > REMINDER_EVICTION_MS) {
    firedReminders.clear();
    lastReminderEviction = now;
  }

  for (const event of events) {
    const minutesUntil = Math.floor((event.startTime - now) / 60_000);

    for (const reminderBefore of reminderMinutes) {
      // Fire reminder if we are within 1 minute of the reminder time
      if (Math.abs(minutesUntil - reminderBefore) < 1) {
        const dedupKey = `${event.id}:${reminderBefore}:${event.startTime}`;
        if (firedReminders.has(dedupKey)) continue;
        firedReminders.add(dedupKey);

        eventBus.publish(
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

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Find all scheduling conflicts (overlapping non-all-day events).
 * Returns an array of conflict descriptors.
 */
export function findConflicts(events: readonly CalendarEvent[]): ConflictInfo[] {
  const filtered = events.filter((e) => !e.allDay);
  const conflicts: ConflictInfo[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < filtered.length; i++) {
    for (let j = i + 1; j < filtered.length; j++) {
      const a = filtered[i];
      const b = filtered[j];
      if (!a || !b) continue;
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

  return conflicts;
}

/**
 * Check for conflicts between a new event and existing overlapping events.
 * Publishes a conflict event to the EventBus if conflicts are found.
 */
export function checkConflictsForEvent(
  newEvent: CalendarEvent,
  overlappingEvents: readonly CalendarEvent[],
  eventBus: EventBus,
): void {
  if (newEvent.allDay) return;

  const conflicts = overlappingEvents.filter((e) => e.id !== newEvent.id && !e.allDay);

  if (conflicts.length > 0) {
    const allEvents = [newEvent, ...conflicts];
    const overlapStart = Math.max(...allEvents.map((e) => e.startTime));
    const overlapEnd = Math.min(...allEvents.map((e) => e.endTime));

    eventBus.publish(
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
