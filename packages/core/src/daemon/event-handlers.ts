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
import type { Logger } from "../logging/logger.ts";
import type { EventHandler, EventHandlerResult } from "../loop/cognitive-loop.ts";
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

// ---------------------------------------------------------------------------
// Handler: user:voice
// ---------------------------------------------------------------------------

async function handleUserVoice(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  try {
    // Runtime-validate payload fields (UserVoicePayload shape)
    const rawPayload = event.payload as Record<string, unknown>;
    const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : "voice";
    const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : "unknown";
    const preTranscribedText = typeof rawPayload.text === "string" ? rawPayload.text : undefined;
    const audioBase64 = typeof rawPayload.audioBase64 === "string" ? rawPayload.audioBase64 : undefined;
    const mimeType = typeof rawPayload.mimeType === "string" ? rawPayload.mimeType : undefined;

    // Case 1: Pre-transcribed text available (client-side STT or test payload)
    if (preTranscribedText && preTranscribedText.trim().length > 0) {
      logger.info("loop-handler", "Voice input with pre-transcribed text, delegating to message handler", {
        eventId: event.id,
        textLength: preTranscribedText.length,
      });
      return delegateVoiceToMessage(modules, event.id, channelId, userId, preTranscribedText, logger);
    }

    // Case 2: Raw audio present -- run server-side STT via GPU worker
    if (audioBase64 && audioBase64.length > 0) {
      return handleVoiceAudioStt(modules, event.id, channelId, userId, audioBase64, mimeType, logger);
    }

    // Case 3: Neither text nor audio provided
    logger.warn("loop-handler", "Voice event received without audio or transcription", {
      eventId: event.id,
    });
    return { success: false, tokensUsed: 0, error: "Voice event has no audio data or transcription" };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:voice handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}

/** Decode base64 audio, run STT, and re-emit as user:message. */
async function handleVoiceAudioStt(
  modules: InitializedModules,
  eventId: string,
  channelId: string,
  userId: string,
  audioBase64: string,
  mimeType: string | undefined,
  logger: Logger,
): Promise<EventHandlerResult> {
  const sttClient = modules.sttClient;

  if (!sttClient) {
    logger.warn("loop-handler", "Voice audio received but STTClient not available (no GPU worker configured)", {
      eventId,
    });
    return { success: false, tokensUsed: 0, error: "STT unavailable: no GPU worker configured" };
  }

  logger.info("loop-handler", "Voice audio received, running STT transcription", {
    eventId,
    audioBase64Length: audioBase64.length,
    mimeType: mimeType ?? "audio/wav",
  });

  // Decode base64 audio to bytes
  let audioBytes: Uint8Array;
  try {
    const binaryStr = atob(audioBase64);
    audioBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      audioBytes[i] = binaryStr.charCodeAt(i);
    }
  } catch (decodeErr: unknown) {
    const errMsg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
    logger.error("loop-handler", `Failed to decode voice audio base64: ${errMsg}`, undefined, {
      eventId,
    });
    return { success: false, tokensUsed: 0, error: `Audio decode failed: ${errMsg}` };
  }

  // Send audio to GPU worker for transcription
  const sttResult = await sttClient.transcribe(audioBytes, mimeType ?? "audio/wav");

  if (!sttResult.ok) {
    logger.warn("loop-handler", `STT transcription failed: ${sttResult.error.message}`, {
      eventId,
      errorCode: sttResult.error.code,
    });
    return { success: false, tokensUsed: 0, error: `STT failed: ${sttResult.error.message}` };
  }

  const transcribedText = sttResult.value.text.trim();

  if (transcribedText.length === 0) {
    logger.debug("loop-handler", "STT returned empty transcription, skipping", {
      eventId,
      confidence: sttResult.value.confidence,
    });
    return { success: true, tokensUsed: 0 };
  }

  logger.info("loop-handler", "STT transcription completed", {
    eventId,
    textLength: transcribedText.length,
    language: sttResult.value.language,
    confidence: sttResult.value.confidence,
    durationSeconds: sttResult.value.durationSeconds,
  });

  // Re-emit as user:message on the EventBus so it flows through the standard pipeline
  if (modules.eventBus) {
    const messagePayload: UserMessagePayload = {
      channelId,
      userId,
      text: transcribedText,
    };
    modules.eventBus.publish("user:message", messagePayload, {
      priority: "high",
      source: "voice-stt",
    });
    return { success: true, tokensUsed: 0 };
  }

  // Fallback: if no EventBus, delegate directly to the text message handler
  return delegateVoiceToMessage(modules, eventId, channelId, userId, transcribedText, logger);
}

/** Helper: create a synthetic user:message and process it via the text handler. */
async function delegateVoiceToMessage(
  modules: InitializedModules,
  eventId: string,
  channelId: string,
  userId: string,
  text: string,
  logger: Logger,
): Promise<EventHandlerResult> {
  const syntheticPayload: UserMessagePayload = { channelId, userId, text };
  return handleUserMessage(modules, { id: eventId, payload: syntheticPayload }, logger);
}

// ---------------------------------------------------------------------------
// Handler: user:approval
// ---------------------------------------------------------------------------

function handleUserApproval(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): EventHandlerResult {
  try {
    const rawPayload = event.payload as Record<string, unknown>;
    const approvalId = typeof rawPayload.approvalId === "string" ? rawPayload.approvalId : undefined;
    const action = typeof rawPayload.action === "string" ? rawPayload.action : undefined;
    const respondedBy = typeof rawPayload.respondedBy === "string" ? rawPayload.respondedBy : "unknown";
    const reason = typeof rawPayload.reason === "string" ? rawPayload.reason : undefined;

    if (!approvalId || !action) {
      logger.warn("loop-handler", "Invalid user:approval payload: missing approvalId or action", {
        eventId: event.id,
      });
      return { success: false, tokensUsed: 0, error: "Invalid payload: missing approvalId or action" };
    }

    if (action !== "approve" && action !== "deny") {
      logger.warn("loop-handler", `Invalid approval action: ${action} (expected "approve" or "deny")`, {
        eventId: event.id,
        approvalId,
      });
      return { success: false, tokensUsed: 0, error: `Invalid approval action: ${action}` };
    }

    const approvalManager = modules.approvalManager;
    if (!approvalManager) {
      logger.warn("loop-handler", "Cannot process approval: ApprovalManager not initialized");
      return { success: false, tokensUsed: 0, error: "ApprovalManager not initialized" };
    }

    const approved = action === "approve";

    logger.info("loop-handler", `Processing approval response: ${action} for ${approvalId}`, {
      eventId: event.id,
      approvalId,
      action,
      respondedBy,
      reason,
    });

    const result = approvalManager.respond({
      requestId: approvalId,
      approved,
      respondedBy,
    });

    if (!result.ok) {
      logger.error("loop-handler", `Approval response failed: ${result.error.message}`, undefined, {
        approvalId,
        errorCode: result.error.code,
      });
      return { success: false, tokensUsed: 0, error: result.error.message };
    }

    // Log denied actions to audit trail
    if (!approved && modules.auditLogger) {
      modules.auditLogger.log({
        actor: respondedBy,
        action: "approval_denied",
        target: result.value.action,
        result: "denied",
        details: {
          approvalId,
          description: result.value.description,
          level: result.value.level,
          channel: result.value.channel,
          reason: reason ?? null,
        },
      });
    }

    // Also audit approved actions for completeness
    if (approved && modules.auditLogger) {
      modules.auditLogger.log({
        actor: respondedBy,
        action: "approval_granted",
        target: result.value.action,
        result: "success",
        details: {
          approvalId,
          description: result.value.description,
          level: result.value.level,
          channel: result.value.channel,
          reason: reason ?? null,
        },
      });
    }

    logger.info("loop-handler", `Approval ${approvalId} resolved: ${action}`, {
      approvalId,
      approvedAction: result.value.action,
      respondedBy,
    });

    return { success: true, tokensUsed: 0 };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:approval handler failed: ${errMsg}`);
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

// ---------------------------------------------------------------------------
// Handler: research:started
// ---------------------------------------------------------------------------

async function handleResearchStarted(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  try {
    const rawPayload = event.payload as Record<string, unknown>;
    const researchId = typeof rawPayload.researchId === "string" ? rawPayload.researchId : undefined;
    const query = typeof rawPayload.query === "string" ? rawPayload.query : undefined;
    const deliverTo = typeof rawPayload.deliverTo === "string" ? rawPayload.deliverTo : undefined;

    if (!query) {
      logger.warn("loop-handler", "Invalid research:started payload: missing query", { eventId: event.id });
      return { success: false, tokensUsed: 0, error: "Invalid payload: missing query" };
    }

    const researchEngine = modules.researchEngine;
    if (!researchEngine) {
      logger.warn("loop-handler", "Cannot process research: ResearchEngine not initialized");
      return { success: false, tokensUsed: 0, error: "ResearchEngine not initialized" };
    }

    // Parse sources from payload (string array or default)
    const rawSources = Array.isArray(rawPayload.sources) ? rawPayload.sources : ["web"];
    const sources = rawSources.filter((s): s is string => typeof s === "string");

    const maxSources =
      typeof rawPayload.maxSources === "number" && rawPayload.maxSources > 0 ? rawPayload.maxSources : 10;

    logger.info("loop-handler", `Starting research: "${query}"`, {
      eventId: event.id,
      researchId,
      sources,
      maxSources,
      deliverTo,
    });

    // Run the research
    const result = await researchEngine.research({
      query,
      sources: sources as ReadonlyArray<"web" | "academic" | "github" | "hackernews" | "reddit">,
      maxSources,
      deliverTo,
    });

    if (!result.ok) {
      logger.error("loop-handler", `Research failed: ${result.error.message}`, undefined, {
        researchId,
        errorCode: result.error.code,
      });

      // Emit research:failed event
      modules.eventBus?.publish(
        "research:failed",
        {
          researchId: researchId ?? event.id,
          query,
          error: result.error.message,
        },
        { priority: "low", source: "research" },
      );

      return { success: false, tokensUsed: 0, error: result.error.message };
    }

    const research = result.value;

    // Store each finding as a long-term memory
    if (modules.memoryStore) {
      for (const finding of research.findings) {
        const content = `[Research] ${finding.title}\n\n${finding.summary}`;
        const tags = ["research", ...sources];
        if (finding.citations.length > 0) {
          tags.push("cited");
        }

        const createResult = modules.memoryStore.create({
          type: "fact",
          layer: "long_term",
          content,
          confidence: finding.confidence,
          source: `research:${research.id}`,
          tags,
          metadata: {
            researchId: research.id,
            query,
            citations: finding.citations.map((c) => ({
              url: c.url,
              title: c.title,
              source: c.source,
            })),
          },
        });

        if (!createResult.ok) {
          logger.warn("loop-handler", `Failed to store research finding: ${createResult.error.message}`);
        }
      }

      logger.info("loop-handler", `Stored ${research.findings.length} research findings in memory`);
    }

    // Emit research:completed event
    modules.eventBus?.publish(
      "research:completed",
      {
        researchId: research.id,
        query,
        findingsCount: research.findings.length,
        citationsCount: research.citations.length,
        tokensUsed: research.tokensUsed,
        durationMs: research.durationMs,
        summary: research.summary,
      },
      { priority: "low", source: "research" },
    );

    // Deliver results to a channel if requested
    if (deliverTo && modules.messageRouter) {
      const summaryText = [
        `**Research Complete: ${query}**`,
        "",
        research.summary,
        "",
        `_${research.findings.length} findings, ${research.citations.length} citations, ${research.durationMs}ms_`,
      ].join("\n");

      const sendResult = await modules.messageRouter.sendNotification(
        {
          id: `research-${research.id}`,
          channelId: deliverTo,
          text: summaryText,
          format: "markdown",
        },
        "normal",
      );

      if (!sendResult.ok) {
        logger.warn("loop-handler", `Failed to deliver research to ${deliverTo}: ${sendResult.error.message}`);
      }
    }

    logger.info("loop-handler", "Research completed successfully", {
      researchId: research.id,
      findingsCount: research.findings.length,
      tokensUsed: research.tokensUsed,
      durationMs: research.durationMs,
    });

    return { success: true, tokensUsed: research.tokensUsed };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `research:started handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Handler: user:feedback
// ---------------------------------------------------------------------------

function handleUserFeedback(
  _modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): EventHandlerResult {
  try {
    const rawPayload = event.payload as Record<string, unknown>;
    const sessionId = typeof rawPayload.sessionId === "string" ? rawPayload.sessionId : undefined;
    const rating = typeof rawPayload.rating === "number" ? rawPayload.rating : undefined;

    if (!sessionId || rating === undefined) {
      logger.warn("loop-handler", "Invalid user:feedback payload: missing sessionId or rating", {
        eventId: event.id,
      });
      return { success: false, tokensUsed: 0, error: "Invalid payload: missing sessionId or rating" };
    }

    logger.info("loop-handler", `User feedback received: session=${sessionId}, rating=${rating}`, {
      eventId: event.id,
      sessionId,
      rating,
    });

    // Confidence adjustment is handled by the EventBus subscription
    // (subscribeFeedbackConfidenceAdjustment) wired during daemon init.
    // This handler only needs to acknowledge the event in the cognitive loop.

    return { success: true, tokensUsed: 0 };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:feedback handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}
