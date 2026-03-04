/**
 * Calendar integration types.
 *
 * Defines interfaces for calendar events, providers (Google Calendar, CalDAV),
 * sync results, and event payloads for the EventBus.
 */

import { z } from "zod";
import type { EidolonError } from "../errors.ts";
import type { Result } from "../result.ts";

// ---------------------------------------------------------------------------
// Calendar Event
// ---------------------------------------------------------------------------

export type CalendarProviderType = "google" | "caldav" | "manual";

export interface CalendarEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly allDay: boolean;
  readonly recurrence?: string;
  readonly reminders: readonly number[];
  readonly source: CalendarProviderType;
  readonly syncedAt: number;
}

// ---------------------------------------------------------------------------
// Calendar Sync Result
// ---------------------------------------------------------------------------

export interface CalendarSyncResult {
  readonly added: number;
  readonly updated: number;
  readonly deleted: number;
  readonly syncToken?: string;
}

// ---------------------------------------------------------------------------
// Calendar Provider
// ---------------------------------------------------------------------------

export interface CalendarProvider {
  readonly id: string;
  readonly name: string;
  connect(): Promise<Result<void, EidolonError>>;
  disconnect(): Promise<void>;
  listEvents(start: number, end: number): Promise<Result<CalendarEvent[], EidolonError>>;
  createEvent(event: Omit<CalendarEvent, "id" | "syncedAt">): Promise<Result<CalendarEvent, EidolonError>>;
  deleteEvent(eventId: string): Promise<Result<void, EidolonError>>;
  sync(since?: string): Promise<Result<CalendarSyncResult, EidolonError>>;
}

// ---------------------------------------------------------------------------
// EventBus payloads
// ---------------------------------------------------------------------------

export interface CalendarEventUpcomingPayload {
  readonly eventId: string;
  readonly title: string;
  readonly startTime: number;
  readonly minutesBefore: number;
}

export interface CalendarEventCreatedPayload {
  readonly eventId: string;
  readonly calendarId: string;
  readonly title: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly source: CalendarProviderType;
}

export interface CalendarConflictDetectedPayload {
  readonly eventIds: readonly string[];
  readonly titles: readonly string[];
  readonly overlapStart: number;
  readonly overlapEnd: number;
}

// ---------------------------------------------------------------------------
// Zod config schema
// ---------------------------------------------------------------------------

export const CalendarProviderConfigSchema = z.object({
  type: z.enum(["google", "caldav"]),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  syncIntervalMinutes: z.number().int().positive().default(15),
});

export const CalendarConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(CalendarProviderConfigSchema).default([]),
  reminders: z
    .object({
      defaultMinutesBefore: z.array(z.number().int().nonnegative()).default([15, 60]),
      notifyVia: z.array(z.string()).default(["telegram"]),
    })
    .default({}),
  injection: z
    .object({
      enabled: z.boolean().default(true),
      daysAhead: z.number().int().positive().default(1),
    })
    .default({}),
});

export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;
export type CalendarProviderConfig = z.infer<typeof CalendarProviderConfigSchema>;
