/**
 * Cognitive loop event handlers for the daemon.
 *
 * Contains the main event handler that routes events to specific handlers
 * (user:message, user:voice, digest:generate, etc.) and the individual
 * handler implementations.
 */

import { randomUUID } from "node:crypto";
import type { UserMessagePayload } from "@eidolon/protocol";
import { loadWorkspaceTemplates } from "../claude/templates.ts";
import type { EventHandler, EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { Logger } from "../logging/logger.ts";
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
        logger.info("loop-handler", "User approval received", { eventId: event.id });
        return { success: true, tokensUsed: 0 };
      }
      case "scheduler:task_due": {
        const taskPayload = event.payload as Record<string, unknown>;
        logger.info("loop-handler", `Scheduled task due: ${String(taskPayload.taskName ?? "unknown")}`, {
          taskId: String(taskPayload.taskId ?? ""),
          action: String(taskPayload.action ?? ""),
        });
        return { success: true, tokensUsed: 0 };
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

// ---------------------------------------------------------------------------
// Handler: user:message
// ---------------------------------------------------------------------------

async function handleUserMessage(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  try {
    // Runtime-validate payload fields (event.payload is typed as unknown)
    const rawPayload = event.payload as Record<string, unknown>;
    const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : undefined;
    const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : undefined;
    const text = typeof rawPayload.text === "string" ? rawPayload.text : undefined;

    if (!channelId || !userId) {
      logger.warn("loop-handler", "Invalid user:message payload: missing channelId or userId", {
        eventId: event.id,
      });
      return { success: false, tokensUsed: 0, error: "Invalid payload: missing channelId or userId" };
    }

    if (!text || text.trim().length === 0) {
      logger.debug("loop-handler", "Empty user message, skipping", { eventId: event.id });
      return { success: true, tokensUsed: 0 };
    }

    logger.info("loop-handler", "Processing user message", {
      eventId: event.id,
      channelId,
      userId,
      textLength: text.length,
    });

    const config = modules.config;
    const claudeManager = modules.claudeManager;
    const workspacePreparer = modules.workspacePreparer;
    const messageRouter = modules.messageRouter;

    if (!config || !claudeManager || !workspacePreparer || !messageRouter) {
      logger.warn(
        "loop-handler",
        "Cannot process message: missing modules (config, claudeManager, workspacePreparer, or messageRouter)",
      );
      return { success: false, tokensUsed: 0, error: "Required modules not initialized" };
    }

    const sessionId = `msg-${randomUUID()}`;

    // 1. Generate MEMORY.md content via MemoryInjector
    let memoryMdContent = "# Memory Context\n\nNo memory system available.\n";
    if (modules.memoryInjector) {
      const memResult = await modules.memoryInjector.generateMemoryMd({
        query: text,
        staticContext: `User: ${config.identity.ownerName}\nTime: ${new Date().toISOString()}`,
      });
      if (memResult.ok) {
        memoryMdContent = memResult.value;
      } else {
        logger.warn("loop-handler", `MemoryInjector failed: ${memResult.error.message}`);
      }
    }

    // 2. Load workspace templates and prepare workspace
    const templateResult = await loadWorkspaceTemplates({
      ownerName: config.identity.ownerName,
      currentTime: new Date().toISOString(),
      channelId,
      sessionType: "main",
    });

    let claudeMd: string;
    let soulMd: string | undefined;
    if (templateResult.ok) {
      claudeMd = templateResult.value.claudeMd;
      soulMd = templateResult.value.soulMd || undefined;
    } else {
      // Fallback to minimal inline content if templates are not found
      logger.warn("loop-handler", `Template loading failed, using fallback: ${templateResult.error.message}`);
      claudeMd = [
        "# Eidolon System Instructions",
        "",
        `You are Eidolon, an autonomous personal AI assistant for ${config.identity.ownerName}.`,
        `Current time: ${new Date().toISOString()}`,
        "",
        "## Rules",
        "- Read MEMORY.md for context about the user and previous conversations.",
        "- When you learn something new about the user, state it explicitly.",
        "- When making decisions, explain your reasoning.",
        "- For external actions, always confirm with the user first.",
        "",
        `## Current Session`,
        `- Channel: ${channelId}`,
        `- Session type: main`,
        "",
      ].join("\n");
    }

    const prepareResult = await workspacePreparer.prepare(sessionId, {
      claudeMd,
      soulMd,
      additionalFiles: {
        "MEMORY.md": memoryMdContent,
      },
    });

    if (!prepareResult.ok) {
      logger.error("loop-handler", `Workspace preparation failed: ${prepareResult.error.message}`);
      return { success: false, tokensUsed: 0, error: prepareResult.error.message };
    }

    const workspaceDir = prepareResult.value;

    // Steps 3-7 are wrapped in try/finally to guarantee workspace cleanup
    try {
      // 3. Invoke Claude Code
      const responseChunks: string[] = [];
      let totalTokens = 0;

      for await (const streamEvent of claudeManager.run(text, {
        sessionId,
        workspaceDir,
        model: config.brain.model.default,
        timeoutMs: config.brain.session.timeoutMs,
      })) {
        switch (streamEvent.type) {
          case "text": {
            if (streamEvent.content) {
              responseChunks.push(streamEvent.content);
            }
            break;
          }
          case "error": {
            logger.error("loop-handler", `Claude stream error: ${streamEvent.error ?? "unknown"}`, undefined, {
              sessionId,
            });
            break;
          }
          case "done": {
            // done events don't carry token info in StreamEvent, but we track what we can
            break;
          }
          default:
            break;
        }
      }

      const responseText = responseChunks.join("");

      if (responseText.length === 0) {
        logger.warn("loop-handler", "Claude returned empty response", { sessionId });
        return { success: true, tokensUsed: 0 };
      }

      // 4. Route response back to the originating channel
      const outboundResult = await messageRouter.routeOutbound({
        id: `resp-${randomUUID()}`,
        channelId,
        text: responseText,
        format: "markdown",
        replyToId: event.id,
      });

      if (!outboundResult.ok) {
        logger.error("loop-handler", `Failed to send response: ${outboundResult.error.message}`, undefined, {
          channelId,
        });
      }

      // 5. Fire-and-forget memory extraction
      if (modules.memoryExtractor) {
        modules.memoryExtractor
          .extract({
            userMessage: text,
            assistantResponse: responseText,
            sessionId,
            timestamp: Date.now(),
          })
          .then((extractResult) => {
            if (extractResult.ok) {
              logger.debug("loop-handler", `Extracted ${extractResult.value.length} memories from conversation`, {
                sessionId,
              });
            } else {
              logger.warn("loop-handler", `Memory extraction failed: ${extractResult.error.message}`);
            }
          })
          .catch((err: unknown) => {
            logger.warn(
              "loop-handler",
              `Memory extraction threw: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }

      // 6. Record token usage (estimate based on text lengths)
      if (modules.tokenTracker) {
        const estimatedInput = Math.ceil(text.length / 4);
        const estimatedOutput = Math.ceil(responseText.length / 4);
        totalTokens = estimatedInput + estimatedOutput;
        modules.tokenTracker.record({
          sessionId,
          sessionType: "main",
          model: config.brain.model.default,
          inputTokens: estimatedInput,
          outputTokens: estimatedOutput,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          timestamp: Date.now(),
        });
      }

      logger.info("loop-handler", "User message processed successfully", {
        sessionId,
        responseLength: responseText.length,
        tokensUsed: totalTokens,
      });

      return { success: true, tokensUsed: totalTokens };
    } catch (claudeErr: unknown) {
      const errMsg = claudeErr instanceof Error ? claudeErr.message : String(claudeErr);
      logger.error("loop-handler", `Message processing failed: ${errMsg}`);
      return { success: false, tokensUsed: 0, error: errMsg };
    } finally {
      // 7. Always clean up workspace, even on error
      workspacePreparer.cleanup(sessionId);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:message handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Handler: user:voice
// ---------------------------------------------------------------------------

async function handleUserVoice(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  try {
    // Runtime-validate payload fields
    const rawPayload = event.payload as Record<string, unknown>;
    const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : undefined;
    const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : undefined;
    const text = typeof rawPayload.text === "string" ? rawPayload.text : undefined;

    if (!channelId || !userId) {
      logger.warn("loop-handler", "Voice payload missing channelId or userId, using defaults", {
        eventId: event.id,
        hasChannelId: !!channelId,
        hasUserId: !!userId,
      });
    }

    if (!text || text.trim().length === 0) {
      logger.warn("loop-handler", "Voice input received without transcription -- STT not wired yet", {
        eventId: event.id,
      });
      return { success: true, tokensUsed: 0 };
    }

    // Delegate to the text message handler with the transcribed text
    logger.info("loop-handler", "Voice input with transcription, delegating to message handler", {
      eventId: event.id,
      textLength: text.length,
    });

    const syntheticPayload: UserMessagePayload = {
      channelId: channelId ?? "voice",
      userId: userId ?? "unknown",
      text,
    };

    return handleUserMessage(modules, { id: event.id, payload: syntheticPayload }, logger);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:voice handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Handler: digest:generate
// ---------------------------------------------------------------------------

async function handleDigestGenerate(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  logger.info("loop-handler", "Digest generation triggered", { eventId: event.id });
  if (!modules.digestBuilder || !modules.messageRouter) {
    logger.warn("loop-handler", "Digest skipped: builder or router not available");
    return { success: true, tokensUsed: 0 };
  }
  const digestResult = modules.digestBuilder.build();
  if (!digestResult.ok) {
    logger.error("loop-handler", `Digest build failed: ${digestResult.error.message}`);
    return { success: false, tokensUsed: 0, error: digestResult.error.message };
  }
  const digest = digestResult.value;
  const digestChannel = modules.config?.digest.channel ?? "telegram";
  const targetChannels =
    digestChannel === "all" ? modules.messageRouter.getChannels().map((c) => c.id) : [digestChannel];
  for (const chId of targetChannels) {
    const sendResult = await modules.messageRouter.sendNotification(
      {
        id: `digest-${digest.generatedAt}`,
        channelId: chId,
        text: digest.markdown,
        format: "markdown",
      },
      "normal",
    );
    if (!sendResult.ok) {
      logger.error("loop-handler", `Digest delivery failed to ${chId}: ${sendResult.error.message}`);
    }
  }
  // Emit digest:delivered event
  modules.eventBus?.publish(
    "digest:delivered",
    {
      title: digest.title,
      generatedAt: digest.generatedAt,
      sectionCount: digest.sections.length,
      channels: targetChannels,
    },
    { priority: "low", source: "digest" },
  );
  logger.info("loop-handler", `Digest delivered: ${digest.title} (${digest.sections.length} sections)`);
  return { success: true, tokensUsed: 0 };
}
