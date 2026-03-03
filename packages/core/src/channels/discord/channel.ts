/**
 * DiscordChannel: Discord bot channel implementation.
 *
 * Implements the Channel interface for bidirectional Discord messaging.
 * Uses an injectable client interface for testability (no direct discord.js dependency).
 * Only whitelisted user IDs may interact with the bot.
 * Supports DM-only mode to restrict interactions to direct messages.
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
import { formatForDiscord, splitDiscordMessage } from "./formatter.ts";

// ---------------------------------------------------------------------------
// Injectable Discord client interface
// ---------------------------------------------------------------------------

/** Represents a Discord message object for sending/editing. */
export interface DiscordMessage {
  readonly id: string;
  readonly content: string;
  readonly channelId: string;
}

/** Represents a Discord user. */
export interface DiscordUser {
  readonly id: string;
  readonly username: string;
  readonly bot?: boolean;
}

/** Represents a Discord attachment. */
export interface DiscordAttachment {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly size: number;
}

/** Represents a Discord inbound message event. */
export interface DiscordInboundMessage {
  readonly id: string;
  readonly content: string;
  readonly channelId: string;
  readonly author: DiscordUser;
  readonly guildId: string | null;
  readonly attachments: readonly DiscordAttachment[];
}

/**
 * Injectable Discord client interface.
 * Production code uses a discord.js Client wrapper.
 * Tests use FakeDiscordClient.
 */
export interface IDiscordClient {
  /** Log in to Discord with the given token. */
  login(token: string): Promise<void>;
  /** Destroy the client and disconnect. */
  destroy(): Promise<void>;
  /** Register a handler for incoming messages. */
  onMessage(handler: (message: DiscordInboundMessage) => Promise<void>): void;
  /** Send a message to a channel. */
  sendMessage(channelId: string, content: string): Promise<DiscordMessage>;
  /** Edit an existing message. */
  editMessage(channelId: string, messageId: string, content: string): Promise<DiscordMessage>;
  /** Whether the client is currently connected. */
  isReady(): boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DiscordConfig {
  readonly botToken: string;
  readonly allowedUserIds: readonly string[];
  readonly guildId?: string;
  readonly dmOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 30;

/** Maximum allowed inbound message text length (100 KB). Longer messages are truncated. */
const MAX_INBOUND_TEXT_LENGTH = 100_000;

/** Retry configuration for transient API failures. */
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

interface RateWindow {
  count: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// DiscordChannel
// ---------------------------------------------------------------------------

export class DiscordChannel implements Channel {
  readonly id = "discord";
  readonly name = "Discord";
  readonly capabilities: ChannelCapabilities = {
    text: true,
    markdown: true,
    images: true,
    documents: true,
    voice: false,
    reactions: true,
    editing: true,
    streaming: false,
  };

  private readonly config: DiscordConfig;
  private readonly logger: Logger;
  private readonly client: IDiscordClient;
  private readonly allowedUserSet: ReadonlySet<string>;
  private readonly userRateLimits: Map<string, RateWindow> = new Map();
  private connected = false;
  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;

  constructor(config: DiscordConfig, client: IDiscordClient, logger: Logger) {
    this.config = config;
    this.client = client;
    this.logger = logger;
    this.allowedUserSet = new Set(config.allowedUserIds);
  }

  async connect(): Promise<Result<void, EidolonError>> {
    if (this.connected) {
      return Ok(undefined);
    }

    try {
      // Register message handler before connecting
      this.client.onMessage(async (msg) => {
        await this.handleIncoming(msg);
      });

      await this.client.login(this.config.botToken);
      this.connected = true;
      this.logger.info("discord", "Bot connected");
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.CHANNEL_AUTH_FAILED, "Failed to connect Discord bot", cause));
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        await this.client.destroy();
      } catch (err) {
        this.logger.error("discord", "Error during disconnect", err);
      }
      this.connected = false;
      this.logger.info("discord", "Bot disconnected");
    }
  }

  async send(message: OutboundMessage): Promise<Result<void, EidolonError>> {
    if (!this.connected) {
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Discord bot is not connected"));
    }

    const channelId = message.channelId;

    try {
      const formatted = message.format === "markdown" ? formatForDiscord(message.text) : message.text;

      const chunks = splitDiscordMessage(formatted);

      for (const chunk of chunks) {
        await this.sendWithRetry(() => this.client.sendMessage(channelId, chunk));
      }

      return Ok(undefined);
    } catch (cause) {
      this.logger.error("discord", "Failed to send message", cause, { channelId });
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Failed to send Discord message", cause));
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

  /** Handle an incoming Discord message event. */
  private async handleIncoming(msg: DiscordInboundMessage): Promise<void> {
    // Ignore bots
    if (msg.author.bot) return;

    // Authorization check
    if (!this.isAuthorized(msg.author.id)) {
      this.logger.warn("discord", "Unauthorized message", {
        userId: msg.author.id,
        username: msg.author.username,
      });
      return;
    }

    // DM-only mode enforcement
    if (this.config.dmOnly && msg.guildId !== null) {
      this.logger.debug("discord", "Non-DM message ignored (dmOnly mode)", {
        userId: msg.author.id,
        guildId: msg.guildId,
      });
      return;
    }

    // Guild restriction
    if (this.config.guildId && msg.guildId !== null && msg.guildId !== this.config.guildId) {
      this.logger.debug("discord", "Message from unauthorized guild ignored", {
        userId: msg.author.id,
        guildId: msg.guildId,
      });
      return;
    }

    // Rate limiting
    if (this.isRateLimited(msg.author.id)) return;

    // Build attachments
    const attachments = this.convertAttachments(msg.attachments);

    // Truncate long text
    const safeText =
      msg.content && msg.content.length > MAX_INBOUND_TEXT_LENGTH
        ? msg.content.slice(0, MAX_INBOUND_TEXT_LENGTH)
        : msg.content;

    const inbound: InboundMessage = {
      id: `dc-${msg.id}-${randomUUID().slice(0, 8)}`,
      channelId: msg.channelId,
      userId: msg.author.id,
      ...(safeText ? { text: safeText } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      timestamp: Date.now(),
    };

    await this.dispatchMessage(inbound);
  }

  /** Check whether a Discord user ID is in the allowed list. */
  private isAuthorized(userId: string): boolean {
    return this.allowedUserSet.has(userId);
  }

  /**
   * Check per-user rate limit: max 30 messages per 60 seconds.
   * Returns true if the message should be dropped.
   */
  private isRateLimited(userId: string): boolean {
    const now = Date.now();
    const entry = this.userRateLimits.get(userId);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.userRateLimits.set(userId, { count: 1, windowStart: now });
      return false;
    }

    entry.count++;
    if (entry.count > RATE_LIMIT_MAX_MESSAGES) {
      this.logger.warn("discord", "Rate limited user", { userId });
      return true;
    }
    return false;
  }

  /** Convert Discord attachments to protocol MessageAttachment format. */
  private convertAttachments(attachments: readonly DiscordAttachment[]): MessageAttachment[] {
    return attachments.map((a) => {
      const type = this.inferAttachmentType(a.contentType, a.filename);
      return {
        type,
        url: a.url,
        mimeType: a.contentType ?? "application/octet-stream",
        filename: a.filename,
        size: a.size,
      };
    });
  }

  /** Infer the MessageAttachment type from MIME type or filename. */
  private inferAttachmentType(contentType: string | null, filename: string): MessageAttachment["type"] {
    if (contentType) {
      if (contentType.startsWith("image/")) return "image";
      if (contentType.startsWith("audio/")) return "audio";
      if (contentType.startsWith("video/")) return "video";
    }

    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext) {
      if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
      if (["mp3", "wav", "ogg", "flac", "m4a"].includes(ext)) return "audio";
      if (["mp4", "webm", "mov", "avi"].includes(ext)) return "video";
    }

    return "document";
  }

  /** Dispatch an inbound message to the registered handler. */
  private async dispatchMessage(message: InboundMessage): Promise<void> {
    if (!this.messageHandler) {
      this.logger.warn("discord", "No message handler registered, dropping message", {
        id: message.id,
      });
      return;
    }

    try {
      await this.messageHandler(message);
    } catch (err) {
      this.logger.error("discord", "Message handler error", err, { id: message.id });
    }
  }

  /**
   * Execute an API call with retry logic for transient failures.
   * Uses exponential backoff for retries.
   */
  private async sendWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;

        // Last attempt -- give up
        if (attempt === MAX_RETRIES) break;

        const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** attempt;

        // Only retry on potentially transient errors
        const isRetryable = this.isTransientError(err);
        if (!isRetryable) {
          throw err;
        }

        this.logger.warn(
          "discord",
          `API call failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delayMs}ms`,
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  /** Check whether an error is potentially transient and retryable. */
  private isTransientError(err: unknown): boolean {
    if (err instanceof Error) {
      const message = err.message.toLowerCase();
      // Network errors and rate limits are transient
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

/** Promise-based sleep for retry delays. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
