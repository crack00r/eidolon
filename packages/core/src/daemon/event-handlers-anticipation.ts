/**
 * Event handlers for anticipation:check and anticipation:suggestion events.
 * Split from event-handlers.ts to keep files under 300 lines.
 */

import type { AnticipationSuggestionPayload } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Handler: anticipation:check
// ---------------------------------------------------------------------------

export async function handleAnticipationCheck(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  logger.info("loop-handler", "Anticipation check triggered", { eventId: event.id });

  if (!modules.anticipationEngine) {
    logger.debug("loop-handler", "Anticipation check skipped: engine not initialized");
    return { success: true, tokensUsed: 0 };
  }

  try {
    const suggestions = await modules.anticipationEngine.check();
    logger.info("loop-handler", `Anticipation check complete: ${suggestions.length} suggestion(s)`);
    return { success: true, tokensUsed: 0 };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `Anticipation check failed: ${msg}`);
    return { success: false, tokensUsed: 0, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Handler: anticipation:suggestion
// ---------------------------------------------------------------------------

export async function handleAnticipationSuggestion(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  const payload = parsePayload(event.payload);
  if (!payload) {
    logger.warn("loop-handler", "Invalid anticipation:suggestion payload", { eventId: event.id });
    return { success: false, tokensUsed: 0, error: "Invalid suggestion payload" };
  }

  logger.info("loop-handler", `Delivering suggestion: ${payload.title}`, {
    patternType: payload.patternType,
    channelId: payload.channelId,
    priority: payload.priority,
  });

  if (!modules.messageRouter) {
    logger.warn("loop-handler", "Cannot deliver suggestion: MessageRouter not available");
    return { success: false, tokensUsed: 0, error: "MessageRouter not available" };
  }

  // Format the notification message
  const text = formatSuggestion(payload);

  const sendResult = await modules.messageRouter.sendNotification(
    {
      id: `suggestion-${payload.suggestionId}`,
      channelId: payload.channelId,
      text,
      format: "markdown",
    },
    payload.priority === "critical" ? "critical" : "normal",
  );

  if (!sendResult.ok) {
    logger.error("loop-handler", `Suggestion delivery failed to ${payload.channelId}: ${sendResult.error.message}`);
    return { success: false, tokensUsed: 0, error: sendResult.error.message };
  }

  logger.info("loop-handler", `Suggestion delivered: ${payload.title}`);
  return { success: true, tokensUsed: 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePayload(raw: unknown): AnticipationSuggestionPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.suggestionId !== "string") return null;
  if (typeof obj.title !== "string") return null;
  if (typeof obj.body !== "string") return null;
  if (typeof obj.channelId !== "string") return null;
  if (typeof obj.patternType !== "string") return null;

  return {
    suggestionId: obj.suggestionId,
    patternType: obj.patternType as AnticipationSuggestionPayload["patternType"],
    title: obj.title,
    body: obj.body,
    channelId: obj.channelId,
    priority: obj.priority === "critical" || obj.priority === "low" ? obj.priority : "normal",
    actionable: typeof obj.actionable === "boolean" ? obj.actionable : false,
    suggestedAction: typeof obj.suggestedAction === "string" ? obj.suggestedAction : undefined,
    calendarEventId: typeof obj.calendarEventId === "string" ? obj.calendarEventId : undefined,
    entityKey: typeof obj.entityKey === "string" ? obj.entityKey : "",
    confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
  };
}

function formatSuggestion(payload: AnticipationSuggestionPayload): string {
  const lines: string[] = [];
  lines.push(`**${payload.title}**`);
  lines.push("");
  lines.push(payload.body);

  if (payload.actionable && payload.suggestedAction) {
    lines.push("");
    lines.push(`_Vorschlag: ${payload.suggestedAction}_`);
  }

  return lines.join("\n");
}
