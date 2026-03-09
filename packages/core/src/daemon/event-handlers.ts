/**
 * Cognitive loop event handler router for the daemon.
 *
 * Routes events to specific handler implementations split across sub-modules
 * to keep each file under 300 lines:
 *   - event-handlers-user.ts     (user:message, user:approval, user:feedback)
 *   - event-handlers-voice.ts    (user:voice, STT, voice-to-message delegation)
 *   - event-handlers-system.ts   (digest:generate)
 *   - event-handlers-learning.ts (research:started)
 *   - task-executor.ts           (scheduler:task_due, scheduler:automation_due)
 */

import type { EventHandler, EventHandlerResult } from "../loop/cognitive-loop.ts";
import { handleAnticipationCheck, handleAnticipationSuggestion } from "./event-handlers-anticipation.ts";
import { handleResearchStarted } from "./event-handlers-learning.ts";
import { handleDigestGenerate } from "./event-handlers-system.ts";
import { handleUserApproval, handleUserFeedback, handleUserMessage } from "./event-handlers-user.ts";
import { handleUserVoice } from "./event-handlers-voice.ts";
import { handleAutomationDue, handleScheduledTask } from "./task-executor.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: build the main event handler used by CognitiveLoop
// ---------------------------------------------------------------------------

export function buildEventHandler(modules: InitializedModules): EventHandler {
  return async (event, priority): Promise<EventHandlerResult> => {
    const logger = modules.logger;
    if (!logger) return { success: false, tokensUsed: 0, error: "Logger not available" };

    logger.info(
      "loop-handler",
      `Handling event: ${event.type} (score: ${priority.score}, action: ${priority.suggestedAction})`,
      {
        eventId: event.id,
        eventType: event.type,
        priority: event.priority,
        suggestedAction: priority.suggestedAction,
        suggestedModel: priority.suggestedModel,
      },
    );

    switch (event.type) {
      case "user:message": {
        return handleUserMessage(modules, event, logger);
      }
      case "user:voice": {
        return handleUserVoice(modules, event, logger);
      }
      case "user:approval": {
        return handleUserApproval(modules, event, logger);
      }
      case "scheduler:task_due": {
        return handleScheduledTask(modules, event, logger);
      }
      case "scheduler:automation_due": {
        return handleAutomationDue(modules, event, logger);
      }
      case "user:feedback": {
        return handleUserFeedback(modules, event, logger);
      }
      case "research:started": {
        return handleResearchStarted(modules, event, logger);
      }
      case "digest:generate": {
        return handleDigestGenerate(modules, event, logger);
      }
      case "anticipation:check": {
        return handleAnticipationCheck(modules, event, logger);
      }
      case "anticipation:suggestion": {
        return handleAnticipationSuggestion(modules, event, logger);
      }
      case "workflow:trigger":
      case "workflow:step_ready": {
        if (!modules.workflowEngine) {
          logger.warn("loop-handler", "WorkflowEngine not available, ignoring workflow event");
          return { success: false, tokensUsed: 0, error: "WorkflowEngine not initialized" };
        }
        if (typeof event.payload !== "object" || event.payload === null) {
          logger.warn("loop-handler", `Invalid workflow event payload: expected object, got ${typeof event.payload}`, {
            eventId: event.id,
            eventType: event.type,
          });
          return { success: false, tokensUsed: 0, error: "Invalid workflow event payload" };
        }
        try {
          const result = await modules.workflowEngine.processEvent(event);
          if (
            typeof result !== "object" ||
            result === null ||
            typeof result.success !== "boolean" ||
            typeof result.tokensUsed !== "number"
          ) {
            logger.warn("loop-handler", "WorkflowEngine.processEvent returned invalid result", {
              eventId: event.id,
              result,
            });
            return { success: false, tokensUsed: 0, error: "Invalid processEvent result" };
          }
          return result;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error("loop-handler", `WorkflowEngine.processEvent threw: ${errMsg}`, {
            eventId: event.id,
            eventType: event.type,
          });
          return { success: false, tokensUsed: 0, error: errMsg };
        }
      }
      case "learning:crawl": {
        // The learning:crawl event is handled directly via EventBus.subscribe
        // in init-learning.ts (fire-and-forget). Acknowledge here so the
        // cognitive loop doesn't treat it as unhandled.
        return { success: true, tokensUsed: 0 };
      }
      case "approval:timeout": {
        logger.warn("loop-handler", "Approval timed out", {
          eventId: event.id,
          payload: event.payload,
        });
        return { success: true, tokensUsed: 0 };
      }
      case "system:shutdown": {
        logger.info("loop-handler", "System shutdown event received");
        return { success: true, tokensUsed: 0 };
      }
      default: {
        logger.debug("loop-handler", `Event handled (no-op): ${event.type}`, {
          eventId: event.id,
          priority: event.priority,
        });
        return { success: true, tokensUsed: 0 };
      }
    }
  };
}
