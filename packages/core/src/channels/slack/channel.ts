/**
 * SlackChannel: Slack bot channel implementation.
 *
 * Implements the Channel interface for bidirectional Slack messaging.
 * Uses an injectable client interface for testability (no direct @slack/bolt dependency).
 * Only whitelisted user IDs may interact with the bot.
 * Supports thread-based replies to keep channels clean.
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
import { formatForSlack, splitSlackMessage } from "./formatter.ts";

// ---------------------------------------------------------------------------
// Injectable Slack client interface
// ---------------------------------------------------------------------------

/** Represents a Slack message for sending/receiving. */
export interface SlackMessage {
  readonly ts: string;
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string;
}

/** Represents a Slack user. */
export interface SlackUser {
  readonly id: string;
  readonly username: string;
  readonly isBot: boolean;
}

/** Represents a Slack file attachment. */
export interface SlackFile {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly urlPrivateDownload?: string;
}

/** Represents an inbound Slack event. */
export interface SlackInboundEvent {
  readonly type: "message" | "app_mention" | "slash_command" | "reaction";
  readonly ts: string;
  readonly channel: string;
  readonly user: SlackUser;
  readonly text: string;
  readonly threadTs?: string;
  readonly files?: readonly SlackFile[];
  readonly reactionName?: string;
  readonly commandName?: string;
  readonly responseUrl?: string;
}

/**
 * Injectable Slack client interface.
 * Production: BoltSlackClient wrapping @slack/bolt App.
 * Tests: FakeSlackClient recording all interactions.
 */
export interface ISlackClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: (event: SlackInboundEvent) => Promise<void>): void;
  postMessage(channel: string, text: string, threadTs?: string): Promise<SlackMessage>;
  addReaction(channel: string, ts: string, emoji: string): Promise<void>;
  downloadFile(url: string): Promise<Uint8Array>;
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SlackConfig {
  readonly botToken: string;
  readonly appToken: string;
  readonly signingSecret: string;
  readonly socketMode: boolean;
  readonly allowedUserIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
  readonly respondInThread: boolean;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 30;

/** Maximum allowed inbound message text length (100 KB). */
const MAX_INBOUND_TEXT_LENGTH = 100_000;

/** Retry configuration for transient API failures. */
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

interface RateWindow {
  count: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// SlackChannel
// ---------------------------------------------------------------------------

export class SlackChannel implements Channel {
  readonly id = "slack";
  readonly name = "Slack";
  readonly capabilities: ChannelCapabilities = {
    text: true,
    markdown: true,
    images: true,
    documents: true,
    voice: false,
    reactions: true,
    editing: false,
    streaming: false,
  };

  private readonly config: SlackConfig;
  private readonly logger: Logger;
  private readonly client: ISlackClient;
  private readonly allowedUserSet: ReadonlySet<string>;
  private readonly allowedChannelSet: ReadonlySet<string>;
  private readonly userRateLimits: Map<string, RateWindow> = new Map();
  private connected = false;
  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;

  constructor(config: SlackConfig, client: ISlackClient, logger: Logger) {
    this.config = config;
    this.client = client;
    this.logger = logger;
    this.allowedUserSet = new Set(config.allowedUserIds);
    this.allowedChannelSet = new Set(config.allowedChannelIds);
  }

  async connect(): Promise<Result<void, EidolonError>> {
    if (this.connected) {
      return Ok(undefined);
    }

    try {
      this.client.onEvent(async (event) => {
        await this.handleIncoming(event);
      });

      await this.client.start();
      this.connected = true;
      this.logger.info("slack", "Bot connected");
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.CHANNEL_AUTH_FAILED, "Failed to connect Slack bot", cause));
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        await this.client.stop();
      } catch (err) {
        this.logger.error("slack", "Error during disconnect", err);
      }
      this.connected = false;
      this.logger.info("slack", "Bot disconnected");
    }
  }

  async send(message: OutboundMessage): Promise<Result<void, EidolonError>> {
    if (!this.connected) {
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Slack bot is not connected"));
    }

    const channelId = message.channelId;

    try {
      const formatted = message.format === "markdown" ? formatForSlack(message.text) : message.text;
      const chunks = splitSlackMessage(formatted);
      const threadTs = this.config.respondInThread ? message.replyToId : undefined;

      for (const chunk of chunks) {
        await this.sendWithRetry(() => this.client.postMessage(channelId, chunk, threadTs));
      }

      return Ok(undefined);
    } catch (cause) {
      this.logger.error("slack", "Failed to send message", cause, { channelId });
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Failed to send Slack message", cause));
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async handleIncoming(event: SlackInboundEvent): Promise<void> {
    if (event.user.isBot) return;

    if (!this.isUserAuthorized(event.user.id)) {
      this.logger.warn("slack", "Unauthorized message", {
        userId: event.user.id,
        username: event.user.username,
      });
      return;
    }

    if (!this.isChannelAuthorized(event.channel)) {
      this.logger.warn("slack", "Message from unauthorized channel", {
        userId: event.user.id,
        channelId: event.channel,
      });
      return;
    }

    if (this.isRateLimited(event.user.id)) return;

    const attachments = this.convertFiles(event.files);

    let safeText = event.text;
    if (safeText && safeText.length > MAX_INBOUND_TEXT_LENGTH) {
      safeText = safeText.slice(0, MAX_INBOUND_TEXT_LENGTH);
    }

    const inbound: InboundMessage = {
      id: `sl-${event.ts}-${randomUUID().slice(0, 8)}`,
      channelId: event.channel,
      userId: event.user.id,
      ...(safeText ? { text: safeText } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(event.threadTs ? { replyToId: event.threadTs } : {}),
      timestamp: Date.now(),
    };

    await this.dispatchMessage(inbound);
  }

  private isUserAuthorized(userId: string): boolean {
    return this.allowedUserSet.has(userId);
  }

  /** Check channel authorization. Empty allowedChannelIds means all channels allowed. */
  private isChannelAuthorized(channelId: string): boolean {
    if (this.allowedChannelSet.size === 0) return true;
    return this.allowedChannelSet.has(channelId);
  }

  private isRateLimited(userId: string): boolean {
    const now = Date.now();

    // Periodically prune expired entries to prevent unbounded growth
    if (this.userRateLimits.size > 1000) {
      this.pruneRateLimits(now);
    }

    const entry = this.userRateLimits.get(userId);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.userRateLimits.set(userId, { count: 1, windowStart: now });
      return false;
    }

    entry.count++;
    if (entry.count > RATE_LIMIT_MAX_MESSAGES) {
      this.logger.warn("slack", "Rate limited user", { userId });
      return true;
    }
    return false;
  }

  /** Remove expired rate limit entries to prevent unbounded Map growth. */
  private pruneRateLimits(now: number): void {
    for (const [key, entry] of this.userRateLimits) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        this.userRateLimits.delete(key);
      }
    }
  }

  private convertFiles(files?: readonly SlackFile[]): MessageAttachment[] {
    if (!files || files.length === 0) return [];

    return files.map((f) => {
      const type = this.inferAttachmentType(f.mimetype, f.name);
      return {
        type,
        url: f.urlPrivateDownload,
        mimeType: f.mimetype,
        filename: f.name,
        size: f.size,
      };
    });
  }

  private inferAttachmentType(mimetype: string, filename: string): MessageAttachment["type"] {
    if (mimetype.startsWith("image/")) return "image";
    if (mimetype.startsWith("audio/")) return "audio";
    if (mimetype.startsWith("video/")) return "video";

    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext) {
      if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
      if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
      if (["mp4", "webm", "mov", "avi"].includes(ext)) return "video";
    }

    return "document";
  }

  private async dispatchMessage(message: InboundMessage): Promise<void> {
    if (!this.messageHandler) {
      this.logger.warn("slack", "No message handler registered, dropping message", {
        id: message.id,
      });
      return;
    }

    try {
      await this.messageHandler(message);
    } catch (err) {
      this.logger.error("slack", "Message handler error", err, { id: message.id });
    }
  }

  private async sendWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt === MAX_RETRIES) break;

        const isRetryable = this.isTransientError(err);
        if (!isRetryable) throw err;

        const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
        this.logger.warn("slack", `API call failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delayMs}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  private isTransientError(err: unknown): boolean {
    if (err instanceof Error) {
      const message = err.message.toLowerCase();
      return (
        message.includes("rate limit") ||
        message.includes("429") ||
        message.includes("500") ||
        message.includes("502") ||
        message.includes("503") ||
        message.includes("504") ||
        message.includes("econnreset") ||
        message.includes("etimedout") ||
        message.includes("network")
      );
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
