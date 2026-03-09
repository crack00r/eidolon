/**
 * ICS / iCalendar parsing and generation helpers -- extracted from caldav.ts.
 *
 * Provides parsing of VEVENT blocks from iCalendar data, conversion of
 * CalendarEvent objects to ICS format, and CalDAV multistatus XML response parsing.
 */

import type { CalendarEvent } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Date conversion
// ---------------------------------------------------------------------------

export function toICalDate(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function formatIcsDate(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function formatIcsDateTime(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

// ---------------------------------------------------------------------------
// ICS field extraction
// ---------------------------------------------------------------------------

/** Escape special regex characters in a string for safe use in RegExp constructors. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractIcsField(vevent: string, field: string): string | null {
  // Handle both simple fields and fields with parameters (e.g., DTSTART;VALUE=DATE:20260101)
  const escaped = escapeRegExp(field);
  const regex = new RegExp(`^${escaped}(?:;[^:]*)?:(.+)$`, "mi");
  const match = regex.exec(vevent);
  return match?.[1]?.trim() ?? null;
}

/** Extract the TZID parameter from a DTSTART/DTEND line. */
function extractTzid(vevent: string, field: string): string | null {
  const escaped = escapeRegExp(field);
  const regex = new RegExp(`^${escaped};[^:]*TZID=([^;:]+)`, "mi");
  const match = regex.exec(vevent);
  return match?.[1]?.trim() ?? null;
}

/**
 * Convert a timezone-aware local time to a UTC timestamp.
 * Uses Intl.DateTimeFormat to resolve the timezone offset.
 */
function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzid: string,
): number | null {
  try {
    // Validate the timezone by attempting to format a date with it
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      year: "numeric",
    });
    formatter.format(new Date());

    // Construct a local date and compute the offset from the timezone
    const isoStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
    const localDate = new Date(isoStr);
    const utcRepr = new Date(localDate.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzRepr = new Date(localDate.toLocaleString("en-US", { timeZone: tzid }));
    const offsetMs = utcRepr.getTime() - tzRepr.getTime();
    return localDate.getTime() + offsetMs;
  } catch {
    return null;
  }
}

function parseIcsDate(value: string, tzid?: string | null): number {
  // Handle formats: YYYYMMDD, YYYYMMDDTHHmmss, YYYYMMDDTHHmmssZ
  if (value.length === 8) {
    // YYYYMMDD -- all-day events, treat as local date
    const year = parseInt(value.substring(0, 4), 10);
    const month = parseInt(value.substring(4, 6), 10) - 1;
    const day = parseInt(value.substring(6, 8), 10);
    return new Date(year, month, day).getTime();
  }

  // YYYYMMDDTHHmmss or YYYYMMDDTHHmmssZ
  const cleaned = value.replace(/[TZ]/g, "");
  const year = parseInt(cleaned.substring(0, 4), 10);
  const month = parseInt(cleaned.substring(4, 6), 10) - 1;
  const day = parseInt(cleaned.substring(6, 8), 10);
  const hour = parseInt(cleaned.substring(8, 10), 10);
  const minute = parseInt(cleaned.substring(10, 12), 10);
  const second = parseInt(cleaned.substring(12, 14), 10);

  if (value.endsWith("Z")) {
    return Date.UTC(year, month, day, hour, minute, second);
  }

  // If TZID is present, convert using timezone-aware logic
  if (tzid) {
    const utcMs = localTimeToUtc(year, month, day, hour, minute, second, tzid);
    if (utcMs !== null) return utcMs;
    // Invalid timezone -- fall through to local time interpretation
  }

  return new Date(year, month, day, hour, minute, second).getTime();
}

// ---------------------------------------------------------------------------
// ICS text escaping
// ---------------------------------------------------------------------------

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------------------
// Public: Parse ICS event
// ---------------------------------------------------------------------------

/**
 * Parse a VEVENT from iCalendar data.
 * This is a simplified parser for the most common fields.
 */
export function parseIcsEvent(icsData: string, calendarPath: string): CalendarEvent | null {
  const veventMatch = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/i.exec(icsData);
  if (!veventMatch?.[1]) return null;

  const vevent = veventMatch[1];

  const uid = extractIcsField(vevent, "UID");
  const summary = extractIcsField(vevent, "SUMMARY");
  const description = extractIcsField(vevent, "DESCRIPTION");
  const location = extractIcsField(vevent, "LOCATION");
  const dtstart = extractIcsField(vevent, "DTSTART");
  const dtend = extractIcsField(vevent, "DTEND");
  const rrule = extractIcsField(vevent, "RRULE");
  const startTzid = extractTzid(vevent, "DTSTART");
  const endTzid = extractTzid(vevent, "DTEND");

  if (!uid || !dtstart) return null;

  const allDay = dtstart.length === 8; // YYYYMMDD format
  const startTime = parseIcsDate(dtstart, startTzid);
  const endTime = dtend ? parseIcsDate(dtend, endTzid ?? startTzid) : startTime + 3_600_000;

  if (Number.isNaN(startTime) || Number.isNaN(endTime)) return null;

  return {
    id: uid,
    calendarId: calendarPath,
    title: summary ?? "(No title)",
    description: description ?? undefined,
    location: location ?? undefined,
    startTime,
    endTime,
    allDay,
    recurrence: rrule ?? undefined,
    reminders: [],
    source: "caldav",
    syncedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Public: Parse multistatus response
// ---------------------------------------------------------------------------

/**
 * Parse a CalDAV multistatus XML response and extract calendar events.
 * Uses simple regex parsing to avoid XML parser dependencies.
 */
export function parseMultistatusResponse(xml: string, calendarPath: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  // Extract all calendar-data content blocks
  const calDataRegex = /<(?:cal|c):calendar-data[^>]*>([\s\S]*?)<\/(?:cal|c):calendar-data>/gi;
  let match: RegExpExecArray | null = calDataRegex.exec(xml);

  while (match !== null) {
    const icsData = decodeXmlEntities(match[1] ?? "");
    const event = parseIcsEvent(icsData, calendarPath);
    if (event) {
      events.push(event);
    }
    match = calDataRegex.exec(xml);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Public: Convert event to ICS
// ---------------------------------------------------------------------------

/**
 * Convert a CalendarEvent to iCalendar (ICS) format.
 */
export function eventToIcs(event: Omit<CalendarEvent, "id" | "syncedAt">, uid: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Eidolon//Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(event.startTime)}`);
    lines.push(`DTEND;VALUE=DATE:${formatIcsDate(event.endTime)}`);
  } else {
    lines.push(`DTSTART:${formatIcsDateTime(event.startTime)}`);
    lines.push(`DTEND:${formatIcsDateTime(event.endTime)}`);
  }

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  if (event.recurrence) {
    lines.push(`RRULE:${event.recurrence}`);
  }

  lines.push(`DTSTAMP:${formatIcsDateTime(Date.now())}`);
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.join("\r\n");
}
