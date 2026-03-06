/**
 * Zod validation schemas for Gateway RPC method parameters.
 *
 * Extracted from server.ts (P1-26) to keep the server module focused
 * on WebSocket lifecycle and connection management.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared error class for RPC parameter validation failures
// ---------------------------------------------------------------------------

export class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcValidationError";
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for RPC method parameters
// ---------------------------------------------------------------------------

const ErrorReportEntrySchema = z
  .object({
    module: z.string().max(256).optional(),
    message: z.string().max(4096).optional(),
    level: z.string().max(64).optional(),
    timestamp: z.union([z.string().max(64), z.number()]).optional(),
    data: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const ErrorReportParamsSchema = z.object({
  errors: z.array(ErrorReportEntrySchema).max(100),
  clientInfo: z
    .object({
      platform: z.string().max(64).optional(),
      version: z.string().max(64).optional(),
    })
    .passthrough()
    .optional(),
});

export const BrainTriggerActionParamsSchema = z.object({
  action: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
});

export const BrainGetLogParamsSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export const ClientExecuteParamsSchema = z.object({
  targetClientId: z.string().min(1).max(256),
  command: z.string().min(1).max(1024),
  args: z.unknown().optional(),
});

export const CommandResultParamsSchema = z.object({
  commandId: z.string().min(1).max(256),
  success: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.string().max(4096).optional(),
});

export const AutomationCreateParamsSchema = z.object({
  input: z.string().min(1).max(2048),
  deliverTo: z.string().min(1).max(64).optional(),
});

export const AutomationListParamsSchema = z.object({
  enabledOnly: z.boolean().optional(),
});

export const AutomationDeleteParamsSchema = z.object({
  automationId: z.string().min(1).max(256),
});

export const ResearchStartParamsSchema = z.object({
  query: z.string().min(1).max(4096),
  sources: z.array(z.string().min(1).max(64)).max(20).optional(),
  maxSources: z.number().int().min(1).max(100).optional(),
  deliverTo: z.string().min(1).max(64).optional(),
});

export const ResearchStatusParamsSchema = z.object({
  researchId: z.string().min(1).max(256),
});

export const ResearchListParamsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  since: z.number().int().min(0).optional(),
});

export const ApprovalListParamsSchema = z.object({
  status: z.enum(["all", "pending", "approved", "denied"]).optional(),
});

export const ApprovalRespondParamsSchema = z.object({
  approvalId: z.string().min(1).max(256),
  action: z.enum(["approve", "deny"]),
  reason: z.string().max(1024).optional(),
});

export const SystemHealthParamsSchema = z.object({
  includeMetrics: z.boolean().optional(),
});

// Calendar RPC param schemas
export const CalendarListEventsParamsSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const CalendarGetUpcomingParamsSchema = z.object({
  hours: z.number().positive().optional(),
});

export const CalendarCreateEventParamsSchema = z.object({
  title: z.string().min(1).max(512),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative(),
  description: z.string().max(4096).optional(),
  location: z.string().max(512).optional(),
  allDay: z.boolean().optional(),
  calendarId: z.string().min(1).max(256).optional(),
});

export const CalendarConflictsParamsSchema = z.object({
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
});
