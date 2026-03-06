/**
 * EmailChannel: IMAP + SMTP email channel implementation.
 *
 * Implements the Channel interface for bidirectional email communication.
 * Uses IMAP polling to receive messages and SMTP to send responses.
 * Only whitelisted sender addresses may interact with the system.
 *
 * Threading is supported via Message-ID / In-Reply-To / References headers
 * per RFC 2822, allowing email conversations to be grouped.
 */

import { randomUUID } from "node:crypto";
import type {
  Channel,
  ChannelCapabilities,
  EidolonError,
  InboundMessage,
  MessageAttachment,
  OutboundMessage,
  Result,
} from "@eidolon/protocol";
import { createError, Err, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { ITracer } from "../../telemetry/tracer.ts";
import { NoopTracer } from "../../telemetry/tracer.ts";
import { buildReplySubject, formatEmailResponse } from "./formatter.ts";
import type { IImapClient, ImapMessage } from "./imap.ts";
import {
  extractThreadInfo,
  isValidEmail,
  parseEmailBody,
  sanitizeEmailContent,
  stripQuotedReply,
  stripSignature,
} from "./parser.ts";
import type { ISmtpClient, SmtpAttachment } from "./smtp.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EmailChannelConfig {
  readonly imap: {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
    readonly user: string;
    readonly password: string;
    readonly pollIntervalMs: number;
    readonly folder: string;
  };
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
    readonly user: string;
    readonly password: string;
    readonly from: string;
  };
  readonly allowedSenders: readonly string[];
  readonly subjectPrefix: string;
  readonly maxAttachmentSizeMb: number;
  readonly threadingEnabled: boolean;
}

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

interface RateWindow {
  count: number;
  windowStart: number;
}

/** Tracks threading state for outbound replies. */
interface ThreadState {
  readonly originalMessageId: string;
  readonly originalSubject: string;
  readonly originalSender: string;
  readonly references: readonly string[];
}

// ---------------------------------------------------------------------------
// EmailChannel
// ---------------------------------------------------------------------------

export class EmailChannel implements Channel {
  readonly id = "email";
  readonly name = "Email";
  readonly capabilities: ChannelCapabilities = {
    text: true,
    markdown: true,
    images: true,
    documents: true,
    voice: false,
    reactions: false,
    editing: false,
    streaming: false,
  };

  private readonly config: EmailChannelConfig;
  private readonly imapClient: IImapClient;
  private readonly smtpClient: ISmtpClient;
  private readonly logger: Logger;
  private readonly tracer: ITracer;

  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  /** Maps outbound message IDs to thread context for reply threading. */
  private readonly threadMap: Map<string, ThreadState> = new Map();

  /** Per-sender rate limiting. */
  private readonly senderRateLimits: Map<string, RateWindow> = new Map();

  /** Normalized allowed sender patterns for fast lookup. */
  private readonly allowedPatterns: readonly string[];

  /** Track reconnection backoff. */
  private reconnectAttempts = 0;

  constructor(
    config: EmailChannelConfig,
    imapClient: IImapClient,
    smtpClient: ISmtpClient,
    logger: Logger,
    tracer?: ITracer,
  ) {
    this.config = config;
    this.imapClient = imapClient;
    this.smtpClient = smtpClient;
    this.logger = logger;
    this.tracer = tracer ?? new NoopTracer();
    this.allowedPatterns = config.allowedSenders.map((s) => s.toLowerCase().trim());
  }

  async connect(): Promise<Result<void, EidolonError>> {
    if (this.connected) {
      return Ok(undefined);
    }

    // Connect IMAP
    const imapResult = await this.imapClient.connect();
    if (!imapResult.ok) {
      return Err(
        createError(
          "CHANNEL_AUTH_FAILED",
          `Email IMAP connection failed: ${imapResult.error.message}`,
          imapResult.error,
        ),
      );
    }

    // Connect SMTP
    const smtpResult = await this.smtpClient.connect();
    if (!smtpResult.ok) {
      await this.imapClient.disconnect();
      return Err(
        createError(
          "CHANNEL_AUTH_FAILED",
          `Email SMTP connection failed: ${smtpResult.error.message}`,
          smtpResult.error,
        ),
      );
    }

    this.connected = true;
    this.reconnectAttempts = 0;

    // Start polling for new messages
    this.startPolling();

    this.logger.info("email", "Email channel connected", {
      imapHost: this.config.imap.host,
      smtpHost: this.config.smtp.host,
      pollIntervalMs: this.config.imap.pollIntervalMs,
    });

    return Ok(undefined);
  }

  async disconnect(): Promise<void> {
    this.stopPolling();

    if (this.imapClient.isConnected()) {
      await this.imapClient.disconnect();
    }
    if (this.smtpClient.isConnected()) {
      await this.smtpClient.disconnect();
    }

    this.connected = false;
    this.threadMap.clear();
    this.logger.info("email", "Email channel disconnected");
  }

  async send(message: OutboundMessage): Promise<Result<void, EidolonError>> {
    if (!this.smtpClient.isConnected()) {
      return Err(createError("CHANNEL_SEND_FAILED", "Email SMTP client is not connected"));
    }

    const span = this.tracer.startSpan("email.send", {
      "email.channel_id": message.channelId,
      "email.is_reply": !!message.replyToId,
    });

    try {
      // Look up threading context if this is a reply
      const thread = message.replyToId ? this.threadMap.get(message.replyToId) : undefined;

      // Format the response
      const { subject, html, text } = formatEmailResponse(message.text, this.config.subjectPrefix);

      // Build the email subject
      const finalSubject = thread ? buildReplySubject(thread.originalSubject, this.config.subjectPrefix) : subject;

      // Determine recipient: from the thread context or fall back to channelId
      const to = thread ? thread.originalSender : message.channelId;

      if (!to || !isValidEmail(to)) {
        span.setStatus("error", "Invalid recipient email address");
        span.end();
        return Err(createError("CHANNEL_SEND_FAILED", `Invalid recipient email address: ${to}`));
      }

      span.setAttribute("email.to", to);
      span.setAttribute("email.subject", finalSubject);

      // Build threading headers
      let inReplyTo: string | undefined;
      let references: readonly string[] | undefined;

      if (thread && this.config.threadingEnabled) {
        inReplyTo = thread.originalMessageId;
        references = [...thread.references, thread.originalMessageId];
      }

      // Convert message attachments to SMTP format
      const smtpAttachments = this.convertAttachments(message.attachments);

      const sendResult = await this.smtpClient.send({
        to: [to],
        subject: finalSubject,
        textBody: text,
        htmlBody: html,
        inReplyTo,
        references,
        attachments: smtpAttachments,
      });

      if (!sendResult.ok) {
        span.setStatus("error", sendResult.error.message);
        span.end();
        return Err(sendResult.error);
      }

      this.logger.debug("email", "Email sent", {
        to,
        subject: finalSubject,
        messageId: sendResult.value,
      });

      span.setStatus("ok");
      span.end();
      return Ok(undefined);
    } catch (cause) {
      this.logger.error("email", "Failed to send email", cause);
      span.setStatus("error", cause instanceof Error ? cause.message : String(cause));
      span.end();
      return Err(createError("CHANNEL_SEND_FAILED", "Failed to send email", cause));
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private startPolling(): void {
    if (this.pollTimer) return;

    // Do an initial poll immediately
    void this.pollForMessages();

    // Then poll on interval
    this.pollTimer = setInterval(() => {
      void this.pollForMessages();
    }, this.config.imap.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollForMessages(): Promise<void> {
    if (!this.imapClient.isConnected()) {
      this.logger.warn("email", "IMAP disconnected during poll, attempting reconnect");
      await this.attemptReconnect();
      return;
    }

    const result = await this.imapClient.fetchNewMessages();

    if (!result.ok) {
      this.logger.error("email", "Failed to fetch new emails", result.error);
      return;
    }

    const messages = result.value;
    if (messages.length === 0) return;

    this.logger.debug("email", `Fetched ${messages.length} new email(s)`);

    for (const email of messages) {
      await this.processInboundEmail(email);
    }
  }

  private async processInboundEmail(email: ImapMessage): Promise<void> {
    const span = this.tracer.startSpan("email.process_inbound", {
      "email.from": email.from,
      "email.subject": email.subject,
      "email.uid": email.uid,
    });

    // Check sender authorization
    if (!this.isAllowedSender(email.from)) {
      this.logger.warn("email", "Email from unauthorized sender", {
        from: email.from,
        subject: email.subject,
      });
      // Mark as read to avoid re-processing
      await this.imapClient.markAsRead(email.uid);
      span.setAttribute("email.skipped", "unauthorized");
      span.setStatus("ok");
      span.end();
      return;
    }

    // Per-sender rate limiting
    if (this.isRateLimited(email.from)) {
      this.logger.warn("email", "Rate limited sender", { from: email.from });
      await this.imapClient.markAsRead(email.uid);
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
      this.logger.debug("email", "Skipping email with empty body after processing", {
        from: email.from,
        subject: email.subject,
      });
      await this.imapClient.markAsRead(email.uid);
      span.setAttribute("email.skipped", "empty_body");
      span.setStatus("ok");
      span.end();
      return;
    }

    // Truncate excessively long content
    const safeText =
      sanitized.length > MAX_INBOUND_TEXT_LENGTH ? sanitized.slice(0, MAX_INBOUND_TEXT_LENGTH) : sanitized;

    // Extract thread info
    const threadInfo = extractThreadInfo(email);

    // Build inbound message
    const inboundId = `email-${email.uid}-${randomUUID().slice(0, 8)}`;
    const attachments = this.filterAttachments(email);

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
    this.threadMap.set(inboundId, {
      originalMessageId: email.messageId,
      originalSubject: email.subject,
      originalSender: email.from,
      references: threadInfo.references as string[],
    });

    // Limit thread map size to prevent memory leaks
    if (this.threadMap.size > 1000) {
      const oldest = this.threadMap.keys().next().value;
      if (oldest !== undefined) {
        this.threadMap.delete(oldest);
      }
    }

    // Mark as read before dispatching
    await this.imapClient.markAsRead(email.uid);

    span.setAttribute("email.has_attachments", attachments.length > 0);
    span.setAttribute("email.is_reply", threadInfo.isReply);
    span.setAttribute("email.body_length", safeText.length);

    // Dispatch to handler
    try {
      await this.dispatchMessage(inbound);
      span.setStatus("ok");
    } catch (err) {
      span.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  }

  // -----------------------------------------------------------------------
  // Authorization
  // -----------------------------------------------------------------------

  /**
   * Check if a sender email is in the allowed list.
   * Supports exact match and wildcard domain patterns (*@example.com).
   */
  isAllowedSender(from: string): boolean {
    const normalizedFrom = from.toLowerCase().trim();

    for (const pattern of this.allowedPatterns) {
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

  // -----------------------------------------------------------------------
  // Rate limiting
  // -----------------------------------------------------------------------

  private isRateLimited(sender: string): boolean {
    const key = sender.toLowerCase();
    const now = Date.now();
    const entry = this.senderRateLimits.get(key);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.senderRateLimits.set(key, { count: 1, windowStart: now });
      return false;
    }

    entry.count++;
    return entry.count > RATE_LIMIT_MAX_MESSAGES;
  }

  // -----------------------------------------------------------------------
  // Attachments
  // -----------------------------------------------------------------------

  /** Filter inbound email attachments by size limit. */
  private filterAttachments(email: ImapMessage): readonly MessageAttachment[] {
    const maxBytes = this.config.maxAttachmentSizeMb * 1024 * 1024;
    const result: MessageAttachment[] = [];

    for (const att of email.attachments) {
      if (att.size > maxBytes) {
        this.logger.warn("email", "Skipping oversized attachment", {
          filename: att.filename,
          size: att.size,
          maxBytes,
        });
        continue;
      }

      result.push({
        type: this.classifyAttachmentType(att.mimeType),
        mimeType: att.mimeType,
        data: att.content,
        filename: att.filename,
        size: att.size,
      });
    }

    return result;
  }

  /** Convert outbound message attachments to SMTP format. */
  private convertAttachments(attachments?: readonly MessageAttachment[]): readonly SmtpAttachment[] {
    if (!attachments || attachments.length === 0) return [];

    return attachments
      .filter((a) => a.data)
      .map((a) => ({
        filename: a.filename ?? "attachment",
        mimeType: a.mimeType,
        content: a.data as Uint8Array,
      }));
  }

  /** Classify MIME type into MessageAttachment type categories. */
  private classifyAttachmentType(mimeType: string): MessageAttachment["type"] {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("video/")) return "video";
    return "document";
  }

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  private async attemptReconnect(): Promise<void> {
    const delay = Math.min(RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempts++;

    this.logger.info("email", `Attempting IMAP reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    await sleep(delay);

    const result = await this.imapClient.connect();
    if (result.ok) {
      this.reconnectAttempts = 0;
      this.logger.info("email", "IMAP reconnected successfully");
    } else {
      this.logger.error("email", "IMAP reconnect failed", result.error);
    }
  }

  // -----------------------------------------------------------------------
  // Message dispatch
  // -----------------------------------------------------------------------

  private async dispatchMessage(message: InboundMessage): Promise<void> {
    if (!this.messageHandler) {
      this.logger.warn("email", "No message handler registered, dropping message", {
        id: message.id,
      });
      return;
    }

    try {
      await this.messageHandler(message);
    } catch (err) {
      this.logger.error("email", "Message handler error", err, { id: message.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
