/**
 * Claude Code session runner with resume/fallback support.
 *
 * Extracted from event-handlers-user.ts to keep files under 300 lines.
 * Handles streaming, session ID capture, and retry-without-resume fallback.
 */

import type { ClaudeSessionOptions, StreamEvent } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeRunResult {
  readonly responseText: string;
  readonly capturedClaudeSessionId: string | undefined;
}

/** Minimal interface for the Claude manager needed by these helpers. */
export interface ClaudeRunner {
  run(prompt: string, options: ClaudeSessionOptions): AsyncIterable<StreamEvent>;
}

/** Minimal interface for the session store's delete operation. */
export interface SessionStoreDelete {
  delete(key: string): void;
}

// ---------------------------------------------------------------------------
// Session runner
// ---------------------------------------------------------------------------

/**
 * Run a Claude Code session and collect the response text + session ID.
 * Supports retry logic for session resumption fallback.
 */
export async function runClaudeSession(
  claudeManager: ClaudeRunner,
  text: string,
  options: ClaudeSessionOptions,
  logger: Logger,
): Promise<ClaudeRunResult> {
  const responseChunks: string[] = [];
  let capturedClaudeSessionId: string | undefined;
  let hadError = false;

  for await (const streamEvent of claudeManager.run(text, options)) {
    switch (streamEvent.type) {
      case "text": {
        if (streamEvent.content) {
          responseChunks.push(streamEvent.content);
        }
        break;
      }
      case "tool_result": {
        if (typeof streamEvent.toolResult === "string" && streamEvent.toolResult.length > 0) {
          responseChunks.push(streamEvent.toolResult);
        }
        break;
      }
      case "session": {
        if (streamEvent.sessionId) {
          capturedClaudeSessionId = streamEvent.sessionId;
        }
        break;
      }
      case "error": {
        hadError = true;
        logger.error("loop-handler", `Claude stream error: ${streamEvent.error ?? "unknown"}`, undefined, {
          sessionId: options.sessionId,
        });
        break;
      }
      case "done":
        break;
      default:
        break;
    }
  }

  return {
    responseText: responseChunks.join(""),
    capturedClaudeSessionId: hadError ? undefined : capturedClaudeSessionId,
  };
}

// ---------------------------------------------------------------------------
// Resume with fallback
// ---------------------------------------------------------------------------

/**
 * Attempt to run with `--resume`. If the resumed session fails (expired/invalid),
 * fall back to a fresh session without resume.
 */
export async function runWithResumeFallback(
  claudeManager: ClaudeRunner,
  text: string,
  baseOptions: ClaudeSessionOptions,
  resumeSessionId: string,
  conversationKey: string,
  sessionStore: SessionStoreDelete | undefined,
  logger: Logger,
): Promise<ClaudeRunResult> {
  logger.debug("loop-handler", "Attempting session resume", {
    conversationKey,
    resumeSessionId,
  });

  try {
    const result = await runClaudeSession(
      claudeManager,
      text,
      { ...baseOptions, resumeSessionId },
      logger,
    );

    // If we got a response, the resume worked
    if (result.responseText.length > 0) {
      return result;
    }

    // Empty response with resume might indicate a stale session -- fall through to retry
    logger.info("loop-handler", "Resume returned empty response, retrying without resume", {
      conversationKey,
      resumeSessionId,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.info("loop-handler", `Session resume failed, retrying without resume: ${errMsg}`, {
      conversationKey,
      resumeSessionId,
    });
  }

  // Invalidate the stale session ID
  sessionStore?.delete(conversationKey);

  // Retry without resume
  return runClaudeSession(claudeManager, text, baseOptions, logger);
}
