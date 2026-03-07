/**
 * Calendar-related RPC handler registrations for the Gateway server.
 */

import type { GatewayMethod } from "@eidolon/protocol";
import type { z } from "zod";
import type { CalendarManager } from "../calendar/index.ts";
import {
  CalendarConflictsParamsSchema,
  CalendarCreateEventParamsSchema,
  CalendarGetUpcomingParamsSchema,
  CalendarListEventsParamsSchema,
  RpcValidationError,
} from "./rpc-schemas.ts";
import type { MethodHandler } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// Calendar handler registration
// ---------------------------------------------------------------------------

export function registerCalendarHandlers(
  calendar: CalendarManager,
  registerHandler: (method: GatewayMethod, handler: MethodHandler) => void,
): void {
  registerHandler("calendar.listEvents", async (params) => {
    const parsed = CalendarListEventsParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.listEvents params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { start, end } = parsed.data;
    const result = calendar.listEvents(start, end);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return { events: result.value };
  });

  registerHandler("calendar.getUpcoming", async (params) => {
    const parsed = CalendarGetUpcomingParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.getUpcoming params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const hours = parsed.data.hours ?? 24;
    const result = calendar.getUpcoming(hours);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return { events: result.value };
  });

  registerHandler("calendar.createEvent", async (params) => {
    const parsed = CalendarCreateEventParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.createEvent params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { title, startTime, endTime, description, location, allDay, calendarId } = parsed.data;
    const result = calendar.createEvent({
      calendarId: calendarId ?? "default",
      title,
      startTime,
      endTime,
      description,
      location,
      allDay: allDay ?? false,
      reminders: [],
      source: "manual",
    });
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return result.value;
  });

  registerHandler("calendar.conflicts", async (params) => {
    const parsed = CalendarConflictsParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.conflicts params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const now = Date.now();
    const start = parsed.data.start ?? now;
    const end = parsed.data.end ?? now + 7 * 86_400_000;
    const result = calendar.findConflicts(start, end);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return { conflicts: result.value };
  });
}
