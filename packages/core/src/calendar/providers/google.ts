/**
 * Google Calendar provider.
 *
 * Uses Google Calendar API v3 via direct HTTP (fetch).
 * OAuth2 credentials are managed via the secret store.
 * Supports incremental sync via syncToken.
 */

import type { CalendarEvent, CalendarProvider, CalendarSyncResult, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../../logging/logger.ts";

// ---------------------------------------------------------------------------
// Zod schemas for Google Calendar API responses
// ---------------------------------------------------------------------------

const GoogleDateTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

const GoogleReminderOverrideSchema = z.object({
  method: z.string(),
  minutes: z.number(),
});

const GoogleEventSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: GoogleDateTimeSchema,
  end: GoogleDateTimeSchema,
  recurrence: z.array(z.string()).optional(),
  reminders: z
    .object({
      useDefault: z.boolean().optional(),
      overrides: z.array(GoogleReminderOverrideSchema).optional(),
    })
    .optional(),
  status: z.string().optional(),
});

const GoogleEventsListSchema = z.object({
  items: z.array(GoogleEventSchema).optional(),
  nextSyncToken: z.string().optional(),
  nextPageToken: z.string().optional(),
});

type GoogleEvent = z.infer<typeof GoogleEventSchema>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GoogleCalendarConfig {
  /** OAuth2 access token (from secret store). */
  readonly accessToken: string;
  /** OAuth2 refresh token (from secret store). */
  readonly refreshToken: string;
  /** OAuth2 client ID. */
  readonly clientId: string;
  /** OAuth2 client secret (from secret store). */
  readonly clientSecret: string;
  /** Calendar ID to sync (defaults to "primary"). */
  readonly calendarId?: string;
}

const GOOGLE_API_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ---------------------------------------------------------------------------
// GoogleCalendarProvider
// ---------------------------------------------------------------------------

export class GoogleCalendarProvider implements CalendarProvider {
  readonly id: string;
  readonly name: string;

  private accessToken: string;
  private readonly refreshToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly calendarId: string;
  private readonly logger: Logger;
  private connected = false;

  constructor(config: GoogleCalendarConfig, logger: Logger, name?: string) {
    this.id = `google-${config.calendarId ?? "primary"}`;
    this.name = name ?? `Google Calendar (${config.calendarId ?? "primary"})`;
    this.accessToken = config.accessToken;
    this.refreshToken = config.refreshToken;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.calendarId = config.calendarId ?? "primary";
    this.logger = logger;
  }

  async connect(): Promise<Result<void, EidolonError>> {
    // Verify connectivity by refreshing the token
    const refreshResult = await this.refreshAccessToken();
    if (!refreshResult.ok) return refreshResult;
    this.connected = true;
    return Ok(undefined);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listEvents(start: number, end: number): Promise<Result<CalendarEvent[], EidolonError>> {
    const params = new URLSearchParams({
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });

    const response = await this.apiGet(`/calendars/${encodeURIComponent(this.calendarId)}/events?${params.toString()}`);
    if (!response.ok) return response;

    const parsed = GoogleEventsListSchema.safeParse(response.value);
    if (!parsed.success) {
      return Err(
        createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Invalid Google API response: ${parsed.error.message}`),
      );
    }

    const events = (parsed.data.items ?? []).filter((e) => e.status !== "cancelled").map((e) => this.mapGoogleEvent(e));

    return Ok(events);
  }

  async createEvent(event: Omit<CalendarEvent, "id" | "syncedAt">): Promise<Result<CalendarEvent, EidolonError>> {
    const body = {
      summary: event.title,
      description: event.description,
      location: event.location,
      start: event.allDay
        ? { date: new Date(event.startTime).toISOString().split("T")[0] }
        : { dateTime: new Date(event.startTime).toISOString() },
      end: event.allDay
        ? { date: new Date(event.endTime).toISOString().split("T")[0] }
        : { dateTime: new Date(event.endTime).toISOString() },
    };

    const response = await this.apiPost(`/calendars/${encodeURIComponent(this.calendarId)}/events`, body);
    if (!response.ok) return response;

    const parsed = GoogleEventSchema.safeParse(response.value);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Invalid create response: ${parsed.error.message}`));
    }

    return Ok(this.mapGoogleEvent(parsed.data));
  }

  async deleteEvent(eventId: string): Promise<Result<void, EidolonError>> {
    const url = `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`;

    try {
      const response = await fetch(`${GOOGLE_API_BASE}${url}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (response.status === 401) {
        const refreshResult = await this.refreshAccessToken();
        if (!refreshResult.ok) return refreshResult;
        const retryResponse = await fetch(`${GOOGLE_API_BASE}${url}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
        if (!retryResponse.ok && retryResponse.status !== 204) {
          return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Delete failed: ${retryResponse.status}`));
        }
        return Ok(undefined);
      }

      if (!response.ok && response.status !== 204) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Delete failed: ${response.status}`));
      }

      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "Delete request failed", cause));
    }
  }

  async sync(since?: string): Promise<Result<CalendarSyncResult, EidolonError>> {
    const params = new URLSearchParams({ maxResults: "250" });

    if (since) {
      params.set("syncToken", since);
    } else {
      // Full sync: get events from 30 days ago to 90 days ahead
      const timeMin = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const timeMax = new Date(Date.now() + 90 * 86_400_000).toISOString();
      params.set("timeMin", timeMin);
      params.set("timeMax", timeMax);
    }

    let allItems: GoogleEvent[] = [];
    let nextPageToken: string | undefined;
    let nextSyncToken: string | undefined;

    do {
      if (nextPageToken) {
        params.set("pageToken", nextPageToken);
      }

      const response = await this.apiGet(
        `/calendars/${encodeURIComponent(this.calendarId)}/events?${params.toString()}`,
      );

      if (!response.ok) {
        // If sync token is invalid, do a full sync
        if (since && response.error.message.includes("410")) {
          return this.sync(undefined);
        }
        return response;
      }

      const parsed = GoogleEventsListSchema.safeParse(response.value);
      if (!parsed.success) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Invalid sync response: ${parsed.error.message}`));
      }

      allItems = allItems.concat(parsed.data.items ?? []);
      nextPageToken = parsed.data.nextPageToken ?? undefined;
      nextSyncToken = parsed.data.nextSyncToken ?? undefined;
    } while (nextPageToken);

    let added = 0;
    const updated = 0;
    let deleted = 0;

    for (const item of allItems) {
      if (item.status === "cancelled") {
        deleted++;
      } else if (item.summary) {
        // We cannot distinguish add vs update without checking DB;
        // treat all as added for simplicity in the sync result.
        added++;
      }
    }

    return Ok({
      added,
      updated,
      deleted,
      syncToken: nextSyncToken,
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private mapGoogleEvent(ge: GoogleEvent): CalendarEvent {
    const allDay = !!ge.start.date;
    const startTime = allDay ? new Date(ge.start.date ?? "").getTime() : new Date(ge.start.dateTime ?? "").getTime();
    const endTime = allDay ? new Date(ge.end.date ?? "").getTime() : new Date(ge.end.dateTime ?? "").getTime();

    const reminders: number[] = ge.reminders?.overrides?.map((o) => o.minutes) ?? [];

    return {
      id: ge.id,
      calendarId: this.calendarId,
      title: ge.summary ?? "(No title)",
      description: ge.description ?? undefined,
      location: ge.location ?? undefined,
      startTime,
      endTime,
      allDay,
      recurrence: ge.recurrence?.join(";") ?? undefined,
      reminders,
      source: "google",
      syncedAt: Date.now(),
    };
  }

  private async apiGet(path: string): Promise<Result<unknown, EidolonError>> {
    try {
      let response = await fetch(`${GOOGLE_API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (response.status === 401) {
        const refreshResult = await this.refreshAccessToken();
        if (!refreshResult.ok) return refreshResult;
        response = await fetch(`${GOOGLE_API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
        });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return Err(
          createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Google API error ${response.status}: ${text.slice(0, 200)}`),
        );
      }

      const data: unknown = await response.json();
      return Ok(data);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "Google API request failed", cause));
    }
  }

  private async apiPost(path: string, body: unknown): Promise<Result<unknown, EidolonError>> {
    try {
      let response = await fetch(`${GOOGLE_API_BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        const refreshResult = await this.refreshAccessToken();
        if (!refreshResult.ok) return refreshResult;
        response = await fetch(`${GOOGLE_API_BASE}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return Err(
          createError(
            ErrorCode.CALENDAR_PROVIDER_ERROR,
            `Google API POST error ${response.status}: ${text.slice(0, 200)}`,
          ),
        );
      }

      const data: unknown = await response.json();
      return Ok(data);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "Google API POST request failed", cause));
    }
  }

  private async refreshAccessToken(): Promise<Result<void, EidolonError>> {
    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, `Token refresh failed: ${response.status}`));
      }

      const data: unknown = await response.json();
      const tokenSchema = z.object({ access_token: z.string() });
      const parsed = tokenSchema.safeParse(data);
      if (!parsed.success) {
        return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "Invalid token response"));
      }

      this.accessToken = parsed.data.access_token;
      this.logger.debug("calendar", "Google access token refreshed");
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "Token refresh request failed", cause));
    }
  }
}
