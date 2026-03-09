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
import { eventToIcs, parseMultistatusResponse, toICalDate } from "./caldav-ics.ts";

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

/** Request timeout for CalDAV HTTP calls (30 seconds). */
const CALDAV_TIMEOUT_MS = 30_000;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
]);

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^0\./, /^169\.254\./, /^::1$/, /^fc/i, /^fd/i, /^fe80/i,
];

function isBlockedCalDAVHost(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid CalDAV server URL";
  }

  const hostname = parsed.hostname.replace(/^\[/, "").replace(/]$/, "").toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return `Blocked hostname: ${hostname} (SSRF protection)`;
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return `Blocked private IP: ${hostname} (SSRF protection)`;
    }
  }

  return undefined;
}

export class CalDAVProvider implements CalendarProvider {
  readonly id: string;
  readonly name: string;

  private readonly serverUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly calendarPath: string;

  constructor(config: CalDAVConfig, _logger: Logger, name?: string) {
    const blocked = isBlockedCalDAVHost(config.serverUrl);
    if (blocked) {
      throw new Error(`CalDAV server URL rejected: ${blocked}`);
    }

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
        signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        redirect: "error",
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
        signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        redirect: "error",
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
    // Use Buffer.from instead of btoa to support non-ASCII passwords
    const encoded = Buffer.from(`${this.username}:${this.password}`).toString("base64");
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
        signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        redirect: "error",
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
        signal: AbortSignal.timeout(CALDAV_TIMEOUT_MS),
        redirect: "error",
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

// Re-export parseIcsEvent for backward compatibility
export { parseIcsEvent } from "./caldav-ics.ts";
