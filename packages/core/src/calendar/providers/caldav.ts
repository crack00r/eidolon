/**
 * CalDAV calendar provider.
 *
 * Implements RFC 4791 for CalDAV calendar access.
 * Supports Nextcloud, Radicale, iCloud, and other CalDAV servers.
 * Parses iCalendar (ICS) data for event information.
 * Uses ctag for incremental sync detection.
 */

import { randomUUID } from "node:crypto";
import type { CalendarEvent, CalendarProvider, CalendarSyncResult, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CalDAVConfig {
  /** CalDAV server URL (e.g., https://nextcloud.example.com/remote.php/dav). */
  readonly serverUrl: string;
  /** Username for Basic auth. */
  readonly username: string;
  /** Password for Basic auth (from secret store). */
  readonly password: string;
  /** Calendar path relative to the server URL. */
  readonly calendarPath: string;
}

// ---------------------------------------------------------------------------
// CalDAVProvider
// ---------------------------------------------------------------------------

export class CalDAVProvider implements CalendarProvider {
  readonly id: string;
  readonly name: string;

  private readonly serverUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly calendarPath: string;

  constructor(config: CalDAVConfig, _logger: Logger, name?: string) {
    this.id = `caldav-${config.calendarPath.replace(/\//g, "-")}`;
    this.name = name ?? `CalDAV (${config.calendarPath})`;
    this.serverUrl = config.serverUrl.replace(/\/$/, "");
    this.username = config.username;
    this.password = config.password;
    this.calendarPath = config.calendarPath;
  }

  async connect(): Promise<Result<void, EidolonError>> {
    // Verify connectivity with a PROPFIND request
    const result = await this.propfind(this.calendarUrl(), 0, "<d:resourcetype/>");
    if (!result.ok) return result;
    return Ok(undefined);
  }

  async disconnect(): Promise<void> {
    // CalDAV is stateless; no connection to close
  }

  async listEvents(start: number, end: number): Promise<Result<CalendarEvent[], EidolonError>> {
    const timeRange = `
      <c:time-range start="${toICalDate(start)}" end="${toICalDate(end)}"/>
    `;

    const body = `<?xml version="1.0" encoding="utf-8" ?>
      <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:getetag/>
          <c:calendar-data/>
        </d:prop>
        <c:filter>
          <c:comp-filter name="VCALENDAR">
            <c:comp-filter name="VEVENT">
              ${timeRange}
            </c:comp-filter>
          </c:comp-filter>
        </c:filter>
      </c:calendar-query>`;

    const result = await this.report(this.calendarUrl(), body);
    if (!result.ok) return result;

    const events = parseMultistatusResponse(result.value, this.calendarPath);
    return Ok(events);
  }

  async createEvent(event: Omit<CalendarEvent, "id" | "syncedAt">): Promise<Result<CalendarEvent, EidolonError>> {
    const uid = randomUUID();
    const icsData = eventToIcs(event, uid);
    const eventUrl = `${this.calendarUrl()}/${uid}.ics`;

    try {
      const response = await fetch(eventUrl, {
        method: "PUT",
        headers: {
          ...this.authHeaders(),
          "Content-Type": "text/calendar; charset=utf-8",
          "If-None-Match": "*",
        },
        body: icsData,
      });

      if (!response.ok) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `CalDAV PUT failed: ${response.status}`));
      }

      const created: CalendarEvent = {
        ...event,
        id: uid,
        syncedAt: Date.now(),
      };

      return Ok(created);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "CalDAV create failed", cause));
    }
  }

  async deleteEvent(eventId: string): Promise<Result<void, EidolonError>> {
    const eventUrl = `${this.calendarUrl()}/${eventId}.ics`;

    try {
      const response = await fetch(eventUrl, {
        method: "DELETE",
        headers: this.authHeaders(),
      });

      if (!response.ok && response.status !== 204 && response.status !== 404) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `CalDAV DELETE failed: ${response.status}`));
      }

      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "CalDAV delete failed", cause));
    }
  }

  async sync(since?: string): Promise<Result<CalendarSyncResult, EidolonError>> {
    // Get current ctag to detect changes
    const ctagResult = await this.getCtag();
    if (!ctagResult.ok) return ctagResult;

    const currentCtag = ctagResult.value;

    // If the ctag hasn't changed, nothing to do
    if (since && since === currentCtag) {
      return Ok({ added: 0, updated: 0, deleted: 0, syncToken: currentCtag });
    }

    // Fetch all events (CalDAV doesn't have incremental sync like Google)
    const now = Date.now();
    const start = now - 30 * 86_400_000;
    const end = now + 90 * 86_400_000;

    const eventsResult = await this.listEvents(start, end);
    if (!eventsResult.ok) return eventsResult;

    return Ok({
      added: eventsResult.value.length,
      updated: 0,
      deleted: 0,
      syncToken: currentCtag,
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private calendarUrl(): string {
    return `${this.serverUrl}${this.calendarPath}`;
  }

  private authHeaders(): Record<string, string> {
    const encoded = btoa(`${this.username}:${this.password}`);
    return { Authorization: `Basic ${encoded}` };
  }

  private async propfind(url: string, depth: number, props: string): Promise<Result<string, EidolonError>> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
        <d:prop>
          ${props}
        </d:prop>
      </d:propfind>`;

    try {
      const response = await fetch(url, {
        method: "PROPFIND",
        headers: {
          ...this.authHeaders(),
          "Content-Type": "application/xml; charset=utf-8",
          Depth: String(depth),
        },
        body,
      });

      if (!response.ok && response.status !== 207) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `PROPFIND failed: ${response.status}`));
      }

      const text = await response.text();
      return Ok(text);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "PROPFIND request failed", cause));
    }
  }

  private async report(url: string, body: string): Promise<Result<string, EidolonError>> {
    try {
      const response = await fetch(url, {
        method: "REPORT",
        headers: {
          ...this.authHeaders(),
          "Content-Type": "application/xml; charset=utf-8",
          Depth: "1",
        },
        body,
      });

      if (!response.ok && response.status !== 207) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `REPORT failed: ${response.status}`));
      }

      const text = await response.text();
      return Ok(text);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "REPORT request failed", cause));
    }
  }

  private async getCtag(): Promise<Result<string, EidolonError>> {
    const result = await this.propfind(this.calendarUrl(), 0, '<cs:getctag xmlns:cs="http://calendarserver.org/ns/"/>');
    if (!result.ok) return result;

    const match = /<cs:getctag[^>]*>([^<]+)<\/cs:getctag>/i.exec(result.value);
    if (!match?.[1]) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "Could not parse ctag from response"));
    }

    return Ok(match[1]);
  }
}

// ---------------------------------------------------------------------------
// ICS / iCalendar helpers
// ---------------------------------------------------------------------------

function toICalDate(timestamp: number): string {
  return new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

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

  if (!uid || !dtstart) return null;

  const allDay = dtstart.length === 8; // YYYYMMDD format
  const startTime = parseIcsDate(dtstart);
  const endTime = dtend ? parseIcsDate(dtend) : startTime + 3_600_000;

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

function extractIcsField(vevent: string, field: string): string | null {
  // Handle both simple fields and fields with parameters (e.g., DTSTART;VALUE=DATE:20260101)
  const regex = new RegExp(`^${field}(?:;[^:]*)?:(.+)$`, "mi");
  const match = regex.exec(vevent);
  return match?.[1]?.trim() ?? null;
}

function parseIcsDate(value: string): number {
  // Handle formats: YYYYMMDD, YYYYMMDDTHHmmss, YYYYMMDDTHHmmssZ
  if (value.length === 8) {
    // YYYYMMDD
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

  return new Date(year, month, day, hour, minute, second).getTime();
}

/**
 * Parse a CalDAV multistatus XML response and extract calendar events.
 * Uses simple regex parsing to avoid XML parser dependencies.
 */
function parseMultistatusResponse(xml: string, calendarPath: string): CalendarEvent[] {
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

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Convert a CalendarEvent to iCalendar (ICS) format.
 */
function eventToIcs(event: Omit<CalendarEvent, "id" | "syncedAt">, uid: string): string {
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

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
