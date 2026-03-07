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
    // Build richer staticContext from UserProfileGenerator if available,
    // otherwise fall back to basic identity info from config.
    let staticContext = `User: ${config.identity.ownerName}\nTime: ${new Date().toISOString()}`;
    if (modules.profileGenerator) {
      try {
        const profileSection = modules.profileGenerator.getProfileSection();
        if (profileSection.length > 0) {
          staticContext = `${profileSection}\nTime: ${new Date().toISOString()}`;
        }
      } catch {
        // Fall back to basic static context on profile generation failure
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
