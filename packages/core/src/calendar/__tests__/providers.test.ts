/**
 * Tests for GoogleCalendarProvider and CalDAVProvider.
 *
 * Mocks globalThis.fetch to verify correct HTTP requests are made
 * and responses are parsed correctly without real network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { CalDAVProvider, parseIcsEvent } from "../providers/caldav.ts";
import { GoogleCalendarProvider } from "../providers/google.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

const logger = createSilentLogger();

/** Stored original fetch reference to restore after each test. */
let originalFetch: typeof globalThis.fetch;

/** Pending fetch mock entries. Each call to mockFetch adds a handler. */
let fetchMocks: Array<{
  match: (url: string, init?: RequestInit) => boolean;
  response: () => Response;
}>;

function setupFetchMock(): void {
  originalFetch = globalThis.fetch;
  fetchMocks = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const mock of fetchMocks) {
      if (mock.match(url, init)) {
        return mock.response();
      }
    }
    return new Response("Not mocked", { status: 500 });
  }) as typeof globalThis.fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function mockFetchFor(
  urlPattern: string | RegExp,
  method: string | undefined,
  body: string | Record<string, unknown>,
  status = 200,
  headers?: Record<string, string>,
): void {
  fetchMocks.push({
    match: (url, init) => {
      const urlMatch = typeof urlPattern === "string" ? url.includes(urlPattern) : urlPattern.test(url);
      const methodMatch = !method || (init?.method ?? "GET").toUpperCase() === method.toUpperCase();
      return urlMatch && methodMatch;
    },
    response: () => {
      const responseBody = typeof body === "string" ? body : JSON.stringify(body);
      const contentType = typeof body === "string" ? "text/xml" : "application/json";
      return new Response(responseBody, {
        status,
        headers: { "Content-Type": contentType, ...headers },
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Google Calendar Provider Tests
// ---------------------------------------------------------------------------

describe("GoogleCalendarProvider", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  afterEach(() => {
    restoreFetch();
  });

  function makeGoogleProvider(): GoogleCalendarProvider {
    return new GoogleCalendarProvider(
      {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        calendarId: "primary",
      },
      logger,
    );
  }

  describe("connect", () => {
    test("succeeds when token refresh works", async () => {
      mockFetchFor("oauth2.googleapis.com/token", "POST", {
        access_token: "new-token",
      });

      const provider = makeGoogleProvider();
      const result = await provider.connect();
      expect(result.ok).toBe(true);
    });

    test("fails when token refresh fails", async () => {
      mockFetchFor("oauth2.googleapis.com/token", "POST", "", 401);

      const provider = makeGoogleProvider();
      const result = await provider.connect();
      expect(result.ok).toBe(false);
    });
  });

  describe("listEvents", () => {
    test("parses Google Calendar API response correctly", async () => {
      // Token refresh for connect
      mockFetchFor("oauth2.googleapis.com/token", "POST", {
        access_token: "fresh-token",
      });
      // Events list
      mockFetchFor("googleapis.com/calendar/v3/calendars", "GET", {
        items: [
          {
            id: "evt-google-1",
            summary: "Team Standup",
            description: "Daily standup meeting",
            location: "Room 42",
            start: { dateTime: "2026-03-15T09:00:00Z" },
            end: { dateTime: "2026-03-15T09:30:00Z" },
            status: "confirmed",
            reminders: {
              useDefault: false,
              overrides: [{ method: "popup", minutes: 10 }],
            },
          },
          {
            id: "evt-google-2",
            summary: "All Day Workshop",
            start: { date: "2026-03-16" },
            end: { date: "2026-03-17" },
            status: "confirmed",
          },
        ],
        nextSyncToken: "sync-tok-1",
      });

      const provider = makeGoogleProvider();
      await provider.connect();

      const now = Date.now();
      const result = await provider.listEvents(now, now + 86_400_000 * 7);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.length).toBe(2);

      // biome-ignore lint/style/noNonNullAssertion: test assertion
      const standup = result.value[0]!;
      expect(standup.id).toBe("evt-google-1");
      expect(standup.title).toBe("Team Standup");
      expect(standup.description).toBe("Daily standup meeting");
      expect(standup.location).toBe("Room 42");
      expect(standup.allDay).toBe(false);
      expect(standup.reminders).toEqual([10]);
      expect(standup.source).toBe("google");

      // biome-ignore lint/style/noNonNullAssertion: test assertion
      const workshop = result.value[1]!;
      expect(workshop.id).toBe("evt-google-2");
      expect(workshop.allDay).toBe(true);
    });

    test("filters out cancelled events", async () => {
      mockFetchFor("oauth2.googleapis.com/token", "POST", {
        access_token: "fresh-token",
      });
      mockFetchFor("googleapis.com/calendar/v3/calendars", "GET", {
        items: [
          {
            id: "evt-ok",
            summary: "Active Event",
            start: { dateTime: "2026-03-15T10:00:00Z" },
            end: { dateTime: "2026-03-15T11:00:00Z" },
            status: "confirmed",
          },
          {
            id: "evt-cancelled",
            summary: "Cancelled Event",
            start: { dateTime: "2026-03-15T12:00:00Z" },
            end: { dateTime: "2026-03-15T13:00:00Z" },
            status: "cancelled",
          },
        ],
      });

      const provider = makeGoogleProvider();
      await provider.connect();

      const now = Date.now();
      const result = await provider.listEvents(now, now + 86_400_000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.id).toBe("evt-ok");
    });
  });

  describe("createEvent", () => {
    test("sends correct request and returns created event", async () => {
      mockFetchFor("oauth2.googleapis.com/token", "POST", {
        access_token: "fresh-token",
      });
      mockFetchFor("googleapis.com/calendar/v3/calendars", "POST", {
        id: "created-evt-1",
        summary: "New Meeting",
        start: { dateTime: "2026-03-20T14:00:00Z" },
        end: { dateTime: "2026-03-20T15:00:00Z" },
        status: "confirmed",
      });

      const provider = makeGoogleProvider();
      await provider.connect();

      const result = await provider.createEvent({
        calendarId: "primary",
        title: "New Meeting",
        startTime: new Date("2026-03-20T14:00:00Z").getTime(),
        endTime: new Date("2026-03-20T15:00:00Z").getTime(),
        allDay: false,
        reminders: [],
        source: "google",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe("created-evt-1");
      expect(result.value.title).toBe("New Meeting");
    });
  });

  describe("deleteEvent", () => {
    test("handles 204 No Content response", async () => {
      mockFetchFor("googleapis.com/calendar/v3/calendars", "DELETE", "", 204);

      const provider = makeGoogleProvider();
      const result = await provider.deleteEvent("evt-to-delete");
      expect(result.ok).toBe(true);
    });

    test("handles 200 OK response", async () => {
      mockFetchFor("googleapis.com/calendar/v3/calendars", "DELETE", "", 200);

      const provider = makeGoogleProvider();
      const result = await provider.deleteEvent("evt-to-delete");
      expect(result.ok).toBe(true);
    });
  });

  describe("sync", () => {
    test("performs full sync without syncToken", async () => {
      mockFetchFor("oauth2.googleapis.com/token", "POST", {
        access_token: "fresh-token",
      });
      mockFetchFor("googleapis.com/calendar/v3/calendars", "GET", {
        items: [
          {
            id: "sync-evt-1",
            summary: "Synced Event",
            start: { dateTime: "2026-03-15T10:00:00Z" },
            end: { dateTime: "2026-03-15T11:00:00Z" },
            status: "confirmed",
          },
        ],
        nextSyncToken: "new-sync-token",
      });

      const provider = makeGoogleProvider();
      await provider.connect();

      const result = await provider.sync();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.added).toBe(1);
      expect(result.value.syncToken).toBe("new-sync-token");
    });

    test("performs incremental sync with syncToken", async () => {
      mockFetchFor("oauth2.googleapis.com/token", "POST", {
        access_token: "fresh-token",
      });
      mockFetchFor("googleapis.com/calendar/v3/calendars", "GET", {
        items: [
          {
            id: "inc-evt-1",
            summary: "Updated Event",
            start: { dateTime: "2026-03-15T10:00:00Z" },
            end: { dateTime: "2026-03-15T11:00:00Z" },
            status: "confirmed",
          },
        ],
        nextSyncToken: "newer-sync-token",
      });

      const provider = makeGoogleProvider();
      await provider.connect();

      const result = await provider.sync("old-sync-token");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.syncToken).toBe("newer-sync-token");
    });
  });
});

// ---------------------------------------------------------------------------
// CalDAV Provider Tests
// ---------------------------------------------------------------------------

describe("CalDAVProvider", () => {
  beforeEach(() => {
    setupFetchMock();
  });

  afterEach(() => {
    restoreFetch();
  });

  function makeCalDAVProvider(): CalDAVProvider {
    return new CalDAVProvider(
      {
        serverUrl: "https://nextcloud.example.com/remote.php/dav",
        username: "testuser",
        password: "testpass",
        calendarPath: "/calendars/testuser/personal",
      },
      logger,
    );
  }

  describe("connect", () => {
    test("succeeds when PROPFIND returns 207", async () => {
      mockFetchFor(
        "nextcloud.example.com",
        "PROPFIND",
        `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:propstat>
              <d:prop><d:resourcetype><d:collection/><cal:calendar xmlns:cal="urn:ietf:params:xml:ns:caldav"/></d:resourcetype></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>`,
        207,
      );

      const provider = makeCalDAVProvider();
      const result = await provider.connect();
      expect(result.ok).toBe(true);
    });

    test("fails when PROPFIND returns error", async () => {
      mockFetchFor("nextcloud.example.com", "PROPFIND", "Unauthorized", 401);

      const provider = makeCalDAVProvider();
      const result = await provider.connect();
      expect(result.ok).toBe(false);
    });
  });

  describe("listEvents", () => {
    test("parses CalDAV multistatus response with VEVENT data", async () => {
      const icsData = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:caldav-uid-1",
        "SUMMARY:CalDAV Meeting",
        "DESCRIPTION:A test meeting",
        "LOCATION:Office",
        "DTSTART:20260315T100000Z",
        "DTEND:20260315T110000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const xmlResponse = `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:response>
            <d:href>/calendars/testuser/personal/event1.ics</d:href>
            <d:propstat>
              <d:prop>
                <d:getetag>"etag-1"</d:getetag>
                <c:calendar-data>${icsData}</c:calendar-data>
              </d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>`;

      mockFetchFor("nextcloud.example.com", "REPORT", xmlResponse, 207);

      const provider = makeCalDAVProvider();
      const now = Date.now();
      const result = await provider.listEvents(now, now + 86_400_000 * 30);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.length).toBe(1);
      const event = result.value[0];
      if (!event) throw new Error("Expected event");
      expect(event.id).toBe("caldav-uid-1");
      expect(event.title).toBe("CalDAV Meeting");
      expect(event.description).toBe("A test meeting");
      expect(event.location).toBe("Office");
      expect(event.allDay).toBe(false);
      expect(event.source).toBe("caldav");
    });

    test("handles response with multiple events", async () => {
      const ics1 = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:uid-a",
        "SUMMARY:Event A",
        "DTSTART:20260315T080000Z",
        "DTEND:20260315T090000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const ics2 = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:uid-b",
        "SUMMARY:Event B",
        "DTSTART:20260315T140000Z",
        "DTEND:20260315T150000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const xmlResponse = `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:response>
            <d:propstat>
              <d:prop><c:calendar-data>${ics1}</c:calendar-data></d:prop>
            </d:propstat>
          </d:response>
          <d:response>
            <d:propstat>
              <d:prop><c:calendar-data>${ics2}</c:calendar-data></d:prop>
            </d:propstat>
          </d:response>
        </d:multistatus>`;

      mockFetchFor("nextcloud.example.com", "REPORT", xmlResponse, 207);

      const provider = makeCalDAVProvider();
      const result = await provider.listEvents(0, Date.now() + 86_400_000 * 365);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
      expect(result.value.map((e) => e.id).sort()).toEqual(["uid-a", "uid-b"]);
    });
  });

  describe("createEvent", () => {
    test("sends PUT request with ICS data", async () => {
      let capturedMethod = "";
      let capturedContentType = "";

      fetchMocks.push({
        match: (url, init) => {
          if (url.includes("nextcloud.example.com") && init?.method === "PUT") {
            capturedMethod = init.method;
            const headers = init.headers as Record<string, string> | undefined;
            capturedContentType = headers?.["Content-Type"] ?? "";
            return true;
          }
          return false;
        },
        response: () => new Response("", { status: 201 }),
      });

      const provider = makeCalDAVProvider();
      const result = await provider.createEvent({
        calendarId: "/calendars/testuser/personal",
        title: "New CalDAV Event",
        startTime: new Date("2026-03-20T10:00:00Z").getTime(),
        endTime: new Date("2026-03-20T11:00:00Z").getTime(),
        allDay: false,
        reminders: [],
        source: "caldav",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.title).toBe("New CalDAV Event");
      expect(result.value.id).toBeTruthy();
      expect(capturedMethod).toBe("PUT");
      expect(capturedContentType).toContain("text/calendar");
    });

    test("returns error on PUT failure", async () => {
      mockFetchFor("nextcloud.example.com", "PUT", "Forbidden", 403);

      const provider = makeCalDAVProvider();
      const result = await provider.createEvent({
        calendarId: "/calendars/testuser/personal",
        title: "Should Fail",
        startTime: Date.now(),
        endTime: Date.now() + 3_600_000,
        allDay: false,
        reminders: [],
        source: "caldav",
      });

      expect(result.ok).toBe(false);
    });
  });

  describe("deleteEvent", () => {
    test("handles 204 No Content response", async () => {
      mockFetchFor("nextcloud.example.com", "DELETE", "", 204);

      const provider = makeCalDAVProvider();
      const result = await provider.deleteEvent("evt-to-delete");
      expect(result.ok).toBe(true);
    });

    test("handles 404 Not Found gracefully", async () => {
      mockFetchFor("nextcloud.example.com", "DELETE", "", 404);

      const provider = makeCalDAVProvider();
      const result = await provider.deleteEvent("nonexistent-evt");
      // 404 is treated as success (event already gone)
      expect(result.ok).toBe(true);
    });
  });

  describe("sync", () => {
    test("performs sync using ctag", async () => {
      // PROPFIND for ctag
      mockFetchFor(
        "nextcloud.example.com",
        "PROPFIND",
        `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
          <d:response>
            <d:propstat>
              <d:prop><cs:getctag>ctag-abc-123</cs:getctag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>`,
        207,
      );

      // REPORT for events
      const icsData = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:sync-uid-1",
        "SUMMARY:Synced Event",
        "DTSTART:20260315T100000Z",
        "DTEND:20260315T110000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      mockFetchFor(
        "nextcloud.example.com",
        "REPORT",
        `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:response>
            <d:propstat>
              <d:prop><c:calendar-data>${icsData}</c:calendar-data></d:prop>
            </d:propstat>
          </d:response>
        </d:multistatus>`,
        207,
      );

      const provider = makeCalDAVProvider();
      const result = await provider.sync();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.added).toBe(1);
      expect(result.value.syncToken).toBe("ctag-abc-123");
    });

    test("returns no changes when ctag matches", async () => {
      mockFetchFor(
        "nextcloud.example.com",
        "PROPFIND",
        `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
          <d:response>
            <d:propstat>
              <d:prop><cs:getctag>same-ctag</cs:getctag></d:prop>
              <d:status>HTTP/1.1 200 OK</d:status>
            </d:propstat>
          </d:response>
        </d:multistatus>`,
        207,
      );

      const provider = makeCalDAVProvider();
      const result = await provider.sync("same-ctag");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.added).toBe(0);
      expect(result.value.updated).toBe(0);
      expect(result.value.deleted).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// ICS Parsing Unit Tests
// ---------------------------------------------------------------------------

describe("parseIcsEvent", () => {
  test("parses a standard VEVENT", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:test-uid-1",
      "SUMMARY:Test Event",
      "DESCRIPTION:A description",
      "LOCATION:Berlin",
      "DTSTART:20260401T140000Z",
      "DTEND:20260401T150000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const event = parseIcsEvent(ics, "/cal/personal");
    expect(event).not.toBeNull();
    if (!event) return;

    expect(event.id).toBe("test-uid-1");
    expect(event.title).toBe("Test Event");
    expect(event.description).toBe("A description");
    expect(event.location).toBe("Berlin");
    expect(event.allDay).toBe(false);
    expect(event.source).toBe("caldav");
  });

  test("parses an all-day event", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:allday-1",
      "SUMMARY:Holiday",
      "DTSTART;VALUE=DATE:20260501",
      "DTEND;VALUE=DATE:20260502",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const event = parseIcsEvent(ics, "/cal/personal");
    expect(event).not.toBeNull();
    if (!event) return;

    expect(event.id).toBe("allday-1");
    expect(event.title).toBe("Holiday");
    expect(event.allDay).toBe(true);
  });

  test("returns null for invalid ICS data", () => {
    const event = parseIcsEvent("not valid ics data", "/cal/personal");
    expect(event).toBeNull();
  });

  test("returns null when UID is missing", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:No UID Event",
      "DTSTART:20260401T140000Z",
      "DTEND:20260401T150000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const event = parseIcsEvent(ics, "/cal/personal");
    expect(event).toBeNull();
  });
});
