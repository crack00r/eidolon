/**
 * User-facing event handlers: user:message, user:approval, user:feedback.
 * Split from event-handlers.ts to keep files under 300 lines.
 */

import { randomUUID } from "node:crypto";
import { loadWorkspaceTemplates } from "../claude/templates.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { InitializedModules } from "./types.ts";

// Re-export approval and feedback handlers from extracted module
export { handleUserApproval, handleUserFeedback } from "./event-handlers-approval.ts";

// ---------------------------------------------------------------------------
// Handler: user:message
// ---------------------------------------------------------------------------

export async function handleUserMessage(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  try {
    // Runtime-validate payload fields (event.payload is typed as unknown)
    if (typeof event.payload !== "object" || event.payload === null) {
      logger.warn("loop-handler", "Invalid user:message payload: expected object", {
        eventId: event.id,
      });
      return { success: false, tokensUsed: 0, error: "Invalid payload: expected object" };
    }
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

    const conversationId = typeof rawPayload.conversationId === "string" ? rawPayload.conversationId : undefined;
    const sessionId = `msg-${randomUUID()}`;

    // 1. Generate MEMORY.md content via MemoryInjector
    // Build richer staticContext from UserProfileGenerator if available,
    // otherwise fall back to basic identity info from config.
    let staticContext = `User: ${config.identity.ownerName}\nTime: ${new Date().toISOString()}`;
    if (modules.profileGenerator) {
      try {
        const profileSection = modules.profileGenerator.getProfileSection();
        if (profileSection.length > 0) {
          staticContext = `${profileSection}\nTime: ${new Date().toISOString()}`;
        }
      } catch (err: unknown) {
        logger.warn("user-handler", "Profile generation failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let memoryMdContent = "# Memory Context\n\nNo memory system available.\n";
    if (modules.memoryInjector) {
      const memResult = await modules.memoryInjector.generateMemoryMd({
        query: text,
        staticContext,
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
          case "tool_result": {
            // Tool results may contain text that should be part of the response
            if (typeof streamEvent.toolResult === "string" && streamEvent.toolResult.length > 0) {
              responseChunks.push(streamEvent.toolResult);
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
        // Send an error message back to the channel so the UI clears the "Thinking..." state
        if (messageRouter) {
          await messageRouter.routeOutbound({
            id: `resp-${randomUUID()}`,
            channelId,
            text: "I wasn't able to generate a response. Please try again.",
            format: "text",
            replyToId: event.id,
            userId,
          });
        }
        return { success: true, tokensUsed: 0 };
      }

      // 4. Route response back to the originating channel
      const outboundResult = await messageRouter.routeOutbound({
        id: `resp-${randomUUID()}`,
        channelId,
        text: responseText,
        format: "markdown",
        replyToId: event.id,
        userId,
      });

      if (!outboundResult.ok) {
        logger.error("loop-handler", `Failed to send response: ${outboundResult.error.message}`, undefined, {
          channelId,
        });
      }

      // 4b. Record conversation messages if conversationStore is available
      if (modules.conversationStore && conversationId) {
        modules.conversationStore.addMessage({
          conversationId,
          role: "user",
          content: text,
        });
        modules.conversationStore.addMessage({
          conversationId,
          role: "assistant",
          content: responseText,
        });
      }

      // 5. Fire-and-forget memory extraction + storage
      if (modules.memoryExtractor) {
        modules.memoryExtractor
          .extract({
            userMessage: text,
            assistantResponse: responseText,
            sessionId,
            timestamp: Date.now(),
          })
          .then((extractResult) => {
            if (!extractResult.ok) {
              logger.warn("loop-handler", `Memory extraction failed: ${extractResult.error.message}`);
              return;
            }
            const extracted = extractResult.value;
            if (extracted.length === 0) return;

            logger.debug("loop-handler", `Extracted ${extracted.length} memories from conversation`, {
              sessionId,
            });

            // Persist extracted memories to the MemoryStore
            if (modules.memoryStore && modules.memoryExtractor) {
              const inputs = modules.memoryExtractor.toCreateInputs(extracted, sessionId);
              const batchResult = modules.memoryStore.createBatch(inputs);
              if (batchResult.ok) {
                logger.info("loop-handler", `Stored ${batchResult.value.length} memories from conversation`, {
                  sessionId,
                });
              } else {
                logger.warn("loop-handler", `Memory storage failed: ${batchResult.error.message}`);
              }
            }
          })
          .catch((err: unknown) => {
            logger.warn("loop-handler", `Memory extraction threw: ${err instanceof Error ? err.message : String(err)}`);
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
      // Send an error message back to the channel so the UI clears the "Thinking..." state
      if (messageRouter) {
        try {
          const userFacingError = sanitizeErrorMessage(errMsg);
          await messageRouter.routeOutbound({
            id: `resp-${randomUUID()}`,
            channelId,
            text: `Sorry, I encountered an error: ${userFacingError}. Please try again.`,
            format: "text",
            replyToId: event.id,
            userId,
          });
        } catch {
          // Best-effort -- don't mask the original error
        }
      }
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
// Helpers
// ---------------------------------------------------------------------------

/** Maximum length of the sanitized error shown to the user. */
const MAX_SANITIZED_LENGTH = 200;

/**
 * Strip internal details (file paths, tokens, stack traces) from an error
 * message before sending it to the user. Only the high-level description
 * is preserved.
 */
function sanitizeErrorMessage(raw: string): string {
  let msg = raw
    // Remove Unix-style absolute paths
    .replace(/\/[^\s:]+\.[a-z]+/gi, "[path]")
    // Remove Windows-style absolute paths
    .replace(/[A-Z]:\\[^\s:]+\.[a-z]+/gi, "[path]")
    // Remove stack trace lines
    .replace(/\n\s+at\s+.*/g, "")
    // Remove anything that looks like a token/key (32+ hex or base64 chars)
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]")
    .trim();

  if (msg.length > MAX_SANITIZED_LENGTH) {
    msg = `${msg.slice(0, MAX_SANITIZED_LENGTH)}...`;
  }

  return msg || "Unknown error";
}
