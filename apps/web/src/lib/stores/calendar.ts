/**
 * Calendar store -- tracks calendar events, upcoming items,
 * and scheduling conflicts.
 * Auto-refreshes upcoming events every 60 seconds.
 */

import { derived, writable } from "svelte/store";
import { clientLog } from "$lib/logger";
import { sanitizeErrorForDisplay } from "$lib/utils";
import { getClient } from "./connection";

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  startTime: number;
  endTime: number;
  allDay: boolean;
  source: string;
}

export interface CalendarConflict {
  eventA: CalendarEvent;
  eventB: CalendarEvent;
  overlapMinutes: number;
}

const REFRESH_INTERVAL_MS = 60_000;

const eventsStore = writable<CalendarEvent[]>([]);
const upcomingStore = writable<CalendarEvent[]>([]);
const conflictsStore = writable<CalendarConflict[]>([]);
const loadingStore = writable(false);
const errorStore = writable<string | null>(null);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function isCalendarEvent(item: unknown): item is CalendarEvent {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.title === "string" &&
    typeof obj.startTime === "number" &&
    typeof obj.endTime === "number"
  );
}

function parseEvents(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCalendarEvent);
}

function parseConflicts(raw: unknown): CalendarConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is CalendarConflict => {
    if (typeof item !== "object" || item === null) return false;
    const obj = item as Record<string, unknown>;
    return (
      isCalendarEvent(obj.eventA) &&
      isCalendarEvent(obj.eventB) &&
      typeof obj.overlapMinutes === "number"
    );
  });
}

export async function fetchCalendarEvents(start: number, end: number): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  loadingStore.set(true);
  errorStore.set(null);

  try {
    const result = await client.call<Record<string, unknown>>("calendar.list", { start, end });
    eventsStore.set(parseEvents(result.events));
  } catch (err) {
    clientLog("error", "calendar", "fetchCalendarEvents failed", err);
    const msg = sanitizeErrorForDisplay(err, "Failed to fetch calendar events");
    errorStore.set(msg);
  } finally {
    loadingStore.set(false);
  }
}

export async function fetchUpcoming(hours = 24): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  loadingStore.set(true);
  errorStore.set(null);

  try {
    const result = await client.call<Record<string, unknown>>("calendar.upcoming", { hours });
    upcomingStore.set(parseEvents(result.events));
  } catch (err) {
    clientLog("error", "calendar", "fetchUpcoming failed", err);
    const msg = sanitizeErrorForDisplay(err, "Failed to fetch upcoming events");
    errorStore.set(msg);
  } finally {
    loadingStore.set(false);
  }
}

export async function createCalendarEvent(event: {
  title: string;
  startTime: number;
  endTime: number;
  description?: string;
  location?: string;
  allDay?: boolean;
  calendarId?: string;
}): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  errorStore.set(null);

  try {
    await client.call("calendar.create", event);
    // Refetch events after creation
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    await fetchCalendarEvents(now - weekMs, now + weekMs);
    await fetchUpcoming();
  } catch (err) {
    clientLog("error", "calendar", "createCalendarEvent failed", err);
    const msg = sanitizeErrorForDisplay(err, "Failed to create calendar event");
    errorStore.set(msg);
  }
}

export async function fetchConflicts(): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    return;
  }

  try {
    const result = await client.call<Record<string, unknown>>("calendar.conflicts", {});
    conflictsStore.set(parseConflicts(result.conflicts));
  } catch (err) {
    clientLog("error", "calendar", "fetchConflicts failed", err);
  }
}

export function startCalendarRefresh(): void {
  stopCalendarRefresh();
  fetchUpcoming();
  fetchConflicts();
  refreshTimer = setInterval(() => {
    fetchUpcoming();
    fetchConflicts();
  }, REFRESH_INTERVAL_MS);
}

export function stopCalendarRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export const calendarEvents = { subscribe: eventsStore.subscribe };
export const upcomingEvents = { subscribe: upcomingStore.subscribe };
export const calendarConflicts = { subscribe: conflictsStore.subscribe };
export const isLoadingCalendar = { subscribe: loadingStore.subscribe };
export const calendarError = { subscribe: errorStore.subscribe };

export const todayEventCount = derived(upcomingStore, (events) => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
  return events.filter((e) => e.startTime >= startOfDay && e.startTime < endOfDay).length;
});

export const nextEvent = derived(upcomingStore, (events) => {
  const now = Date.now();
  const future = events.filter((e) => e.endTime > now);
  const first = future[0];
  if (!first) return null;
  return future.reduce((closest, e) => (e.startTime < closest.startTime ? e : closest), first);
});
