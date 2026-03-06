/**
 * Email polling, reconnection, and inbound message processing.
 *
 * Extracted from channel.ts to keep the main EmailChannel class under 300 lines.
 * These functions are used internally by EmailChannel.
 */

import { randomUUID } from "node:crypto";
import type { InboundMessage } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { ITracer } from "../../telemetry/tracer.ts";
import { filterAttachments } from "./attachments.ts";
import type { IImapClient, ImapMessage } from "./imap.ts";
import { extractThreadInfo, parseEmailBody, sanitizeEmailContent, stripQuotedReply, stripSignature } from "./parser.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum inbound text length (100 KB). Longer content is truncated. */
const MAX_INBOUND_TEXT_LENGTH = 100_000;

/** Per-sender rate limit: max messages per window. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 20;

/** Retry delay for reconnection attempts. */
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 300_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateWindow {
  count: number;
  windowStart: number;
}

/** Tracks threading state for outbound replies. */
export interface ThreadState {
  readonly originalMessageId: string;
  readonly originalSubject: string;
  readonly originalSender: string;
  readonly references: readonly string[];
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export function isRateLimited(senderRateLimits: Map<string, RateWindow>, sender: string): boolean {
  const key = sender.toLowerCase();
  const now = Date.now();
  const entry = senderRateLimits.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    senderRateLimits.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT_MAX_MESSAGES;
}

// ---------------------------------------------------------------------------
// Sender authorization
// ---------------------------------------------------------------------------

/**
 * Check if a sender email is in the allowed list.
 * Supports exact match and wildcard domain patterns (*@example.com).
 */
export function isAllowedSender(from: string, allowedPatterns: readonly string[]): boolean {
  const normalizedFrom = from.toLowerCase().trim();

  for (const pattern of allowedPatterns) {
    // Exact match
    if (pattern === normalizedFrom) return true;

    // Wildcard domain match: *@example.com
    if (pattern.startsWith("*@")) {
      const domain = pattern.slice(1); // "@example.com"
      if (normalizedFrom.endsWith(domain)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Inbound email processing
// ---------------------------------------------------------------------------

export interface ProcessEmailDeps {
  readonly imapClient: IImapClient;
  readonly logger: Logger;
  readonly tracer: ITracer;
  readonly allowedPatterns: readonly string[];
  readonly senderRateLimits: Map<string, RateWindow>;
  readonly threadMap: Map<string, ThreadState>;
  readonly maxAttachmentSizeMb: number;
  readonly messageHandler: ((message: InboundMessage) => Promise<void>) | null;
}

export async function processInboundEmail(email: ImapMessage, deps: ProcessEmailDeps): Promise<void> {
  const span = deps.tracer.startSpan("email.process_inbound", {
    "email.from": email.from,
    "email.subject": email.subject,
    "email.uid": email.uid,
  });

  // Check sender authorization
  if (!isAllowedSender(email.from, deps.allowedPatterns)) {
    deps.logger.warn("email", "Email from unauthorized sender", {
      from: email.from,
      subject: email.subject,
    });
    // Mark as read to avoid re-processing
    await deps.imapClient.markAsRead(email.uid);
    span.setAttribute("email.skipped", "unauthorized");
    span.setStatus("ok");
    span.end();
    return;
  }

  // Per-sender rate limiting
  if (isRateLimited(deps.senderRateLimits, email.from)) {
    deps.logger.warn("email", "Rate limited sender", { from: email.from });
    await deps.imapClient.markAsRead(email.uid);
    span.setAttribute("email.skipped", "rate_limited");
    span.setStatus("ok");
    span.end();
    return;
  }

  // Parse and clean the email body
  const rawBody = parseEmailBody(email.textBody, email.htmlBody);
  const withoutQuotes = stripQuotedReply(rawBody);
  const withoutSignature = stripSignature(withoutQuotes);
  const sanitized = sanitizeEmailContent(withoutSignature);

  if (sanitized.length === 0) {
    deps.logger.debug("email", "Skipping email with empty body after processing", {
      from: email.from,
      subject: email.subject,
    });
    await deps.imapClient.markAsRead(email.uid);
    span.setAttribute("email.skipped", "empty_body");
    span.setStatus("ok");
    span.end();
    return;
  }

  // Truncate excessively long content
  const safeText = sanitized.length > MAX_INBOUND_TEXT_LENGTH ? sanitized.slice(0, MAX_INBOUND_TEXT_LENGTH) : sanitized;

  // Extract thread info
  const threadInfo = extractThreadInfo(email);

  // Build inbound message
  const inboundId = `email-${email.uid}-${randomUUID().slice(0, 8)}`;
  const attachments = filterAttachments(email, deps.maxAttachmentSizeMb, deps.logger);

  const inbound: InboundMessage = {
    id: inboundId,
    channelId: email.from,
    userId: email.from,
    text: safeText,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(threadInfo.isReply ? { replyToId: threadInfo.inReplyTo } : {}),
    timestamp: email.date.getTime(),
  };

  // Store thread context for reply
  deps.threadMap.set(inboundId, {
    originalMessageId: email.messageId,
    originalSubject: email.subject,
    originalSender: email.from,
    references: threadInfo.references as string[],
  });

  // Limit thread map size to prevent memory leaks
  if (deps.threadMap.size > 1000) {
    const oldest = deps.threadMap.keys().next().value;
    if (oldest !== undefined) {
      deps.threadMap.delete(oldest);
    }
  }

  // Mark as read before dispatching
  await deps.imapClient.markAsRead(email.uid);

  span.setAttribute("email.has_attachments", attachments.length > 0);
  span.setAttribute("email.is_reply", threadInfo.isReply);
  span.setAttribute("email.body_length", safeText.length);

  // Dispatch to handler
  try {
    if (!deps.messageHandler) {
      deps.logger.warn("email", "No message handler registered, dropping message", {
        id: inbound.id,
      });
    } else {
      try {
        await deps.messageHandler(inbound);
      } catch (err) {
        deps.logger.error("email", "Message handler error", err, { id: inbound.id });
      }
    }
    span.setStatus("ok");
  } catch (err) {
    span.setStatus("error", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    span.end();
  }
}

// ---------------------------------------------------------------------------
// Reconnection
// ---------------------------------------------------------------------------

export async function attemptReconnect(
  imapClient: IImapClient,
  reconnectAttempts: number,
  logger: Logger,
): Promise<{ newAttempts: number }> {
  const delay = Math.min(RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
  const attempts = reconnectAttempts + 1;

  logger.info("email", `Attempting IMAP reconnect in ${delay}ms (attempt ${attempts})`);

  await sleep(delay);

  const result = await imapClient.connect();
  if (result.ok) {
    logger.info("email", "IMAP reconnected successfully");
    return { newAttempts: 0 };
  }

  logger.error("email", "IMAP reconnect failed", result.error);
  return { newAttempts: attempts };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
