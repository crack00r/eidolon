/**
 * WhatsAppChannel: WhatsApp Business API channel implementation.
 *
 * Implements the Channel interface for bidirectional WhatsApp messaging.
 * Uses an injectable WhatsAppApiClient interface for testability.
 * Only whitelisted phone numbers (E.164 format) may interact.
 *
 * Key constraints:
 * - 24-hour messaging window: can only send messages to users who messaged
 *   within the last 24 hours (template messages are NOT supported yet).
 * - 4096-character message limit per WhatsApp message.
 * - Media types: image, document, audio, video.
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
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { ITracer } from "../../telemetry/tracer.ts";
import { NoopTracer } from "../../telemetry/tracer.ts";
import type { WhatsAppApiClient } from "./api.ts";
import { formatForWhatsApp, splitWhatsAppMessage } from "./formatter.ts";
import type { WhatsAppWebhookEvent, WhatsAppWebhookMessage } from "./webhook.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WhatsAppChannelConfig {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly allowedPhoneNumbers: readonly string[];
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 30;

/** Maximum allowed inbound message text length (100 KB). */
const MAX_INBOUND_TEXT_LENGTH = 100_000;

/** 24-hour messaging window in milliseconds. */
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

interface RateWindow {
  count: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// WhatsAppChannel
// ---------------------------------------------------------------------------

export class WhatsAppChannel implements Channel {
  readonly id = "whatsapp";
  readonly name = "WhatsApp";
  readonly capabilities: ChannelCapabilities = {
    text: true,
    markdown: false,
    images: true,
    documents: true,
    voice: true,
    reactions: true,
    editing: false,
    streaming: false,
  };

  private readonly config: WhatsAppChannelConfig;
  private readonly api: WhatsAppApiClient;
  private readonly logger: Logger;
  private readonly tracer: ITracer;
  private readonly allowedPhoneSet: ReadonlySet<string>;
  private readonly userRateLimits: Map<string, RateWindow> = new Map();
  /** Tracks last inbound timestamp per user for the 24-hour messaging window. */
  private readonly lastInboundTimestamp: Map<string, number> = new Map();
  private connected = false;
  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;

  constructor(config: WhatsAppChannelConfig, api: WhatsAppApiClient, logger: Logger, tracer?: ITracer) {
    this.config = config;
    this.api = api;
    this.logger = logger;
    this.tracer = tracer ?? new NoopTracer();
    this.allowedPhoneSet = new Set(config.allowedPhoneNumbers);
  }

  async connect(): Promise<Result<void, EidolonError>> {
    if (this.connected) {
      return Ok(undefined);
    }

    // WhatsApp uses webhooks (not long polling), so "connect" simply marks the channel as ready.
    // The actual webhook endpoint is registered in the gateway server.
    this.connected = true;
    this.logger.info("whatsapp", "Channel connected (webhook mode)");
    return Ok(undefined);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.userRateLimits.clear();
    this.lastInboundTimestamp.clear();
    this.logger.info("whatsapp", "Channel disconnected");
  }

  async send(message: OutboundMessage): Promise<Result<void, EidolonError>> {
    if (!this.connected) {
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "WhatsApp channel is not connected"));
    }

    const to = message.channelId;
    const span = this.tracer.startSpan("whatsapp.send", {
      "whatsapp.to": to,
      "message.format": message.format ?? "text",
    });

    // Check 24-hour messaging window
    if (!this.isWithinMessagingWindow(to)) {
      span.setStatus("error", "Outside 24-hour messaging window");
      span.end();
      return Err(
        createError(
          ErrorCode.CHANNEL_SEND_FAILED,
          `Cannot send to ${to}: outside 24-hour messaging window. User must message first.`,
        ),
      );
    }

    try {
      // Format text for WhatsApp (limited markdown support)
      const formatted = message.format === "markdown" ? formatForWhatsApp(message.text) : message.text;

      const chunks = splitWhatsAppMessage(formatted);
      span.setAttribute("message.chunks", chunks.length);

      for (const chunk of chunks) {
        const result = await this.api.sendText(to, chunk);
        if (!result.ok) {
          span.setStatus("error", result.error.message);
          span.end();
          return Err(
            createError(ErrorCode.CHANNEL_SEND_FAILED, `Failed to send WhatsApp message: ${result.error.message}`),
          );
        }
      }

      span.setStatus("ok");
      span.end();
      return Ok(undefined);
    } catch (cause) {
      this.logger.error("whatsapp", "Failed to send message", cause, { to });
      span.setStatus("error", cause instanceof Error ? cause.message : String(cause));
      span.end();
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Failed to send WhatsApp message", cause));
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Webhook event handling (called by the gateway)
  // -------------------------------------------------------------------------

  /**
   * Process parsed webhook events from the gateway.
   * Each event may contain multiple messages.
   */
  async handleWebhookEvents(events: readonly WhatsAppWebhookEvent[]): Promise<void> {
    const span = this.tracer.startSpan("whatsapp.webhook", {
      "webhook.event_count": events.length,
    });

    let messageCount = 0;
    try {
      for (const event of events) {
        for (const msg of event.messages) {
          messageCount++;
          await this.handleIncomingMessage(msg, event.phoneNumberId);
        }
      }
      span.setAttribute("webhook.message_count", messageCount);
      span.setStatus("ok");
    } catch (err) {
      span.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async handleIncomingMessage(msg: WhatsAppWebhookMessage, _phoneNumberId: string): Promise<void> {
    // Authorization check
    if (!this.isAuthorized(msg.from)) {
      this.logger.warn("whatsapp", "Unauthorized message", { from: msg.from });
      return;
    }

    // Rate limiting
    if (this.isRateLimited(msg.from)) return;

    // Update 24-hour messaging window
    this.lastInboundTimestamp.set(msg.from, Date.now());

    // Mark as read (best-effort, do not block message processing)
    this.api.markAsRead(msg.messageId).catch((err: unknown) => {
      this.logger.debug("whatsapp", "Failed to mark message as read (non-fatal)", {
        messageId: msg.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Build inbound message
    const inbound = this.toInboundMessage(msg);

    await this.dispatchMessage(inbound);
  }

  /** Check whether a phone number is in the allowed list. */
  private isAuthorized(phoneNumber: string): boolean {
    return this.allowedPhoneSet.has(phoneNumber);
  }

  /**
   * Check per-user rate limit: max 30 messages per 60 seconds.
   * Returns true if the message should be dropped.
   */
  private isRateLimited(phoneNumber: string): boolean {
    const now = Date.now();
    const entry = this.userRateLimits.get(phoneNumber);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.userRateLimits.set(phoneNumber, { count: 1, windowStart: now });
      return false;
    }

    entry.count++;
    if (entry.count > RATE_LIMIT_MAX_MESSAGES) {
      this.logger.warn("whatsapp", "Rate limited user", { phoneNumber });
      return true;
    }
    return false;
  }

  /** Check whether the recipient is within the 24-hour messaging window. */
  private isWithinMessagingWindow(phoneNumber: string): boolean {
    const lastTimestamp = this.lastInboundTimestamp.get(phoneNumber);
    if (lastTimestamp === undefined) return false;
    return Date.now() - lastTimestamp < MESSAGING_WINDOW_MS;
  }

  /** Build an InboundMessage from a WhatsApp webhook message. */
  private toInboundMessage(msg: WhatsAppWebhookMessage): InboundMessage {
    const text = msg.text ?? msg.caption;
    const safeText = text && text.length > MAX_INBOUND_TEXT_LENGTH ? text.slice(0, MAX_INBOUND_TEXT_LENGTH) : text;

    const attachments = this.buildAttachments(msg);

    return {
      id: `wa-${msg.messageId}-${randomUUID().slice(0, 8)}`,
      channelId: msg.from,
      userId: msg.from,
      ...(safeText ? { text: safeText } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      timestamp: msg.timestamp || Date.now(),
    };
  }

  /** Build MessageAttachment array from a WhatsApp message. */
  private buildAttachments(msg: WhatsAppWebhookMessage): MessageAttachment[] {
    if (!msg.mediaId) return [];

    const typeMap: Record<string, MessageAttachment["type"]> = {
      image: "image",
      document: "document",
      audio: "audio",
      video: "video",
    };

    const attachmentType = typeMap[msg.type];
    if (!attachmentType) return [];

    return [
      {
        type: attachmentType,
        mimeType: msg.mimeType ?? "application/octet-stream",
        ...(msg.filename ? { filename: msg.filename } : {}),
        // Store mediaId as url for downstream processing (media download is deferred)
        url: `whatsapp-media://${msg.mediaId}`,
      },
    ];
  }

  /** Dispatch an inbound message to the registered handler. */
  private async dispatchMessage(message: InboundMessage): Promise<void> {
    if (!this.messageHandler) {
      this.logger.warn("whatsapp", "No message handler registered, dropping message", {
        id: message.id,
      });
      return;
    }

    try {
      await this.messageHandler(message);
    } catch (err) {
      this.logger.error("whatsapp", "Message handler error", err, { id: message.id });
    }
  }
}
