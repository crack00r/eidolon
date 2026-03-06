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
