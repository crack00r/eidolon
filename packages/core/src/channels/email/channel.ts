/**
 * EmailChannel: IMAP + SMTP email channel implementation.
 *
 * Implements the Channel interface for bidirectional email communication.
 * Uses IMAP polling to receive messages and SMTP to send responses.
 * Only whitelisted sender addresses may interact with the system.
 *
 * Threading is supported via Message-ID / In-Reply-To / References headers
 * per RFC 2822, allowing email conversations to be grouped.
 *
 * Polling, reconnection, and inbound processing are in polling.ts.
 * Attachment utilities are in attachments.ts.
 */

import type {
  Channel,
  ChannelCapabilities,
  EidolonError,
  InboundMessage,
  OutboundMessage,
  Result,
} from "@eidolon/protocol";
import { createError, Err, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { ITracer } from "../../telemetry/tracer.ts";
import { NoopTracer } from "../../telemetry/tracer.ts";
import { convertAttachments } from "./attachments.ts";
import { buildReplySubject, formatEmailResponse } from "./formatter.ts";
import type { IImapClient } from "./imap.ts";
import { isValidEmail } from "./parser.ts";
import {
  type ProcessEmailDeps,
  type RateWindow,
  type ThreadState,
  attemptReconnect,
  processInboundEmail,
} from "./polling.ts";
import type { ISmtpClient } from "./smtp.ts";

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
      const thread = message.replyToId ? this.threadMap.get(message.replyToId) : undefined;
      const { subject, html, text } = formatEmailResponse(message.text, this.config.subjectPrefix);
      const finalSubject = thread ? buildReplySubject(thread.originalSubject, this.config.subjectPrefix) : subject;
      const to = thread ? thread.originalSender : message.channelId;

      if (!to || !isValidEmail(to)) {
        span.setStatus("error", "Invalid recipient email address");
        span.end();
        return Err(createError("CHANNEL_SEND_FAILED", `Invalid recipient email address: ${to}`));
      }

      span.setAttribute("email.to", to);
      span.setAttribute("email.subject", finalSubject);

      let inReplyTo: string | undefined;
      let references: readonly string[] | undefined;

      if (thread && this.config.threadingEnabled) {
        inReplyTo = thread.originalMessageId;
        references = [...thread.references, thread.originalMessageId];
      }

      const smtpAttachments = convertAttachments(message.attachments);

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

      this.logger.debug("email", "Email sent", { to, subject: finalSubject, messageId: sendResult.value });
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
    void this.pollForMessages();
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
      const { newAttempts } = await attemptReconnect(this.imapClient, this.reconnectAttempts, this.logger);
      this.reconnectAttempts = newAttempts;
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

    const deps: ProcessEmailDeps = {
      imapClient: this.imapClient,
      logger: this.logger,
      tracer: this.tracer,
      allowedPatterns: this.allowedPatterns,
      senderRateLimits: this.senderRateLimits,
      threadMap: this.threadMap,
      maxAttachmentSizeMb: this.config.maxAttachmentSizeMb,
      messageHandler: this.messageHandler,
    };

    for (const email of messages) {
      await processInboundEmail(email, deps);
    }
  }
}
