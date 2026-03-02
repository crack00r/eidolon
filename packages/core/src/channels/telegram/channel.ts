/**
 * TelegramChannel: grammy-based Telegram bot channel.
 *
 * Implements the Channel interface for bidirectional Telegram messaging.
 * Uses long polling to receive messages and the Bot API to send them.
 * Only whitelisted user IDs may interact with the bot.
 */

import { randomUUID } from "node:crypto";
import type {
  Channel,
  ChannelCapabilities,
  EidolonError,
  InboundMessage,
  OutboundMessage,
  Result,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { Bot, GrammyError, HttpError } from "grammy";
import type { Logger } from "../../logging/logger.js";
import { formatForTelegram, splitMessage } from "./formatter.js";
import { downloadTelegramFile, toAttachment } from "./media.js";

// ---------------------------------------------------------------------------
// Retry configuration for transient API failures
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

/** Fatal error descriptions that indicate the bot token is invalid or revoked. */
const FATAL_ERROR_PATTERNS: readonly RegExp[] = [
  /unauthorized/i,
  /bot.*was.*blocked/i,
  /bot.*was.*kicked/i,
  /not found/i,
];

export interface TelegramConfig {
  readonly botToken: string;
  readonly allowedUserIds: readonly number[];
  readonly typingIndicator?: boolean;
}

/** Map of grammy MIME type helpers to MessageAttachment types. */
type AttachmentType = "image" | "document" | "audio" | "voice" | "video";

// Finding #10: Per-user rate limiting
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 30;

/** Maximum allowed inbound message text length (100 KB). Longer messages are truncated. */
const MAX_INBOUND_TEXT_LENGTH = 100_000;

interface RateWindow {
  count: number;
  windowStart: number;
}

export class TelegramChannel implements Channel {
  readonly id = "telegram";
  readonly name = "Telegram";
  readonly capabilities: ChannelCapabilities = {
    text: true,
    markdown: true,
    images: true,
    documents: true,
    voice: true,
    reactions: false,
    editing: true,
    streaming: false,
  };

  private readonly config: TelegramConfig;
  private readonly logger: Logger;
  private readonly allowedUserSet: ReadonlySet<number>;
  private readonly userRateLimits: Map<number, RateWindow> = new Map();
  private bot: Bot | null = null;
  private connected = false;
  private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;

  constructor(config: TelegramConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.allowedUserSet = new Set(config.allowedUserIds);
  }

  async connect(): Promise<Result<void, EidolonError>> {
    if (this.connected) {
      return Ok(undefined);
    }

    try {
      const bot = new Bot(this.config.botToken);
      this.bot = bot;

      // Global error handler: log and check for fatal errors
      bot.catch((err) => {
        const isFatal = this.isFatalBotError(err.error);
        if (isFatal) {
          this.logger.error("telegram", "Fatal bot error — marking channel as disconnected", err.error);
          this.connected = false;
        } else {
          this.logger.error("telegram", "Bot error caught", err.error, {
            update: String(err.ctx?.update?.update_id ?? "unknown"),
          });
        }
      });

      this.registerHandlers(bot);

      // Start long polling (non-blocking) with error callback for fatal polling failures
      bot
        .start({
          onStart: () => {
            this.logger.info("telegram", "Bot started polling");
          },
        })
        .catch((err: unknown) => {
          this.logger.error("telegram", "Fatal polling error — bot stopped", err);
          this.connected = false;
          this.bot = null;
        });

      this.connected = true;
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.CHANNEL_AUTH_FAILED, "Failed to connect Telegram bot", cause));
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
      this.connected = false;
      this.logger.info("telegram", "Bot stopped");
    }
  }

  async send(message: OutboundMessage): Promise<Result<void, EidolonError>> {
    if (!this.bot) {
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Telegram bot is not connected"));
    }

    // The channelId for Telegram outbound is the chat ID
    const chatId = message.replyToId ?? message.channelId;

    try {
      const typingEnabled = this.config.typingIndicator !== false;

      // Format based on message format
      const formatted = message.format === "markdown" ? formatForTelegram(message.text) : message.text;

      const chunks = splitMessage(formatted);

      for (const chunk of chunks) {
        // Typing indicator is best-effort: failure must not block message delivery
        if (typingEnabled) {
          try {
            await this.bot.api.sendChatAction(chatId, "typing");
          } catch (typingErr) {
            this.logger.debug("telegram", "Typing indicator failed (non-fatal)", {
              error: typingErr instanceof Error ? typingErr.message : String(typingErr),
              chatId,
            });
          }
        }

        const parseMode = message.format === "markdown" ? ("MarkdownV2" as const) : undefined;
        const bot = this.bot;
        if (!bot) {
          return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Telegram bot disconnected during send"));
        }
        await this.sendWithRetry(() =>
          bot.api.sendMessage(chatId, chunk, {
            parse_mode: parseMode,
          }),
        );
      }

      return Ok(undefined);
    } catch (cause) {
      this.logger.error("telegram", "Failed to send message", cause, { chatId });
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, "Failed to send Telegram message", cause));
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Register grammy message handlers with authorization checks. */
  private registerHandlers(bot: Bot): void {
    // Text messages
    bot.on("message:text", async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id)) {
        this.logger.warn("telegram", "Unauthorized message", {
          userId: ctx.from?.id,
        });
        return;
      }

      // Finding #10: Per-user rate limiting
      if (ctx.from?.id !== undefined && this.isRateLimited(ctx.from.id)) return;

      const inbound = this.toInboundMessage(
        String(ctx.message.message_id),
        String(ctx.chat.id),
        String(ctx.from.id),
        ctx.message.text,
        ctx.message.reply_to_message?.message_id ? String(ctx.message.reply_to_message.message_id) : undefined,
      );

      await this.dispatchMessage(inbound);
    });

    // Photo messages
    bot.on("message:photo", async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id)) return;
      if (ctx.from?.id !== undefined && this.isRateLimited(ctx.from.id)) return;

      const photo = ctx.message.photo;
      const largest = photo[photo.length - 1];
      if (!largest) return;

      const attachments = await this.downloadMediaAttachment(largest.file_id, "image", "image/jpeg");

      const inbound = this.toInboundMessage(
        String(ctx.message.message_id),
        String(ctx.chat.id),
        String(ctx.from.id),
        ctx.message.caption,
        undefined,
        attachments ? [attachments] : undefined,
      );

      await this.dispatchMessage(inbound);
    });

    // Document messages
    bot.on("message:document", async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id)) return;
      if (ctx.from?.id !== undefined && this.isRateLimited(ctx.from.id)) return;

      const doc = ctx.message.document;
      const attachment = await this.downloadMediaAttachment(
        doc.file_id,
        "document",
        doc.mime_type ?? "application/octet-stream",
        doc.file_name,
      );

      const inbound = this.toInboundMessage(
        String(ctx.message.message_id),
        String(ctx.chat.id),
        String(ctx.from.id),
        ctx.message.caption,
        undefined,
        attachment ? [attachment] : undefined,
      );

      await this.dispatchMessage(inbound);
    });

    // Voice messages
    bot.on("message:voice", async (ctx) => {
      if (!this.isAuthorized(ctx.from?.id)) return;
      if (ctx.from?.id !== undefined && this.isRateLimited(ctx.from.id)) return;

      const voice = ctx.message.voice;
      const attachment = await this.downloadMediaAttachment(voice.file_id, "voice", voice.mime_type ?? "audio/ogg");

      const inbound = this.toInboundMessage(
        String(ctx.message.message_id),
        String(ctx.chat.id),
        String(ctx.from.id),
        undefined,
        undefined,
        attachment ? [attachment] : undefined,
      );

      await this.dispatchMessage(inbound);
    });
  }

  /** Check whether a Telegram user ID is in the allowed list. */
  private isAuthorized(userId: number | undefined): boolean {
    if (userId === undefined) return false;
    return this.allowedUserSet.has(userId);
  }

  /**
   * Check per-user rate limit: max 30 messages per 60 seconds.
   * Returns true if the message should be dropped.
   */
  private isRateLimited(userId: number): boolean {
    const now = Date.now();
    const entry = this.userRateLimits.get(userId);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.userRateLimits.set(userId, { count: 1, windowStart: now });
      return false;
    }

    entry.count++;
    if (entry.count > RATE_LIMIT_MAX_MESSAGES) {
      this.logger.warn("telegram", "Rate limited user", { userId });
      return true;
    }
    return false;
  }

  /** Build an InboundMessage from Telegram context fields. */
  private toInboundMessage(
    messageId: string,
    chatId: string,
    userId: string,
    text?: string,
    replyToId?: string,
    attachments?: readonly import("@eidolon/protocol").MessageAttachment[],
  ): InboundMessage {
    // Truncate excessively long inbound text to prevent resource exhaustion
    const safeText = text && text.length > MAX_INBOUND_TEXT_LENGTH ? text.slice(0, MAX_INBOUND_TEXT_LENGTH) : text;
    return {
      id: `tg-${messageId}-${randomUUID().slice(0, 8)}`,
      channelId: chatId,
      userId,
      ...(safeText ? { text: safeText } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(attachments ? { attachments } : {}),
      timestamp: Date.now(),
    };
  }

  /** Download a media file from Telegram and convert to MessageAttachment. */
  private async downloadMediaAttachment(
    fileId: string,
    type: AttachmentType,
    mimeType: string,
    filename?: string,
  ): Promise<import("@eidolon/protocol").MessageAttachment | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const data = await downloadTelegramFile(this.config.botToken, file.file_path);
      return toAttachment(type, mimeType, data, filename);
    } catch (err) {
      this.logger.error("telegram", "Failed to download media", err, { fileId });
      return null;
    }
  }

  /** Dispatch an inbound message to the registered handler. */
  private async dispatchMessage(message: InboundMessage): Promise<void> {
    if (!this.messageHandler) {
      this.logger.warn("telegram", "No message handler registered, dropping message", {
        id: message.id,
      });
      return;
    }

    try {
      await this.messageHandler(message);
    } catch (err) {
      this.logger.error("telegram", "Message handler error", err, { id: message.id });
    }
  }

  /**
   * Execute an API call with retry logic for transient failures.
   * Handles HTTP 429 (rate limit) by respecting Telegram's `retry_after` parameter.
   */
  private async sendWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;

        // Don't retry fatal errors
        if (this.isFatalBotError(err)) {
          throw err;
        }

        // Last attempt — give up
        if (attempt === MAX_RETRIES) break;

        // Handle HTTP 429 with retry_after from Telegram
        let delayMs = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
        if (err instanceof GrammyError && err.error_code === 429) {
          const parameters = (err as GrammyError & { parameters?: { retry_after?: number } }).parameters;
          const retryAfter = parameters?.retry_after;
          if (typeof retryAfter === "number" && retryAfter > 0) {
            delayMs = retryAfter * 1000;
          }
        }

        // Only retry on transient HTTP errors (429, 5xx) or network errors
        const isRetryable =
          err instanceof HttpError || (err instanceof GrammyError && (err.error_code === 429 || err.error_code >= 500));

        if (!isRetryable) {
          throw err;
        }

        this.logger.warn(
          "telegram",
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

  /** Check whether an error indicates a fatal, non-recoverable bot issue. */
  private isFatalBotError(err: unknown): boolean {
    if (err instanceof GrammyError) {
      // 401 Unauthorized = token revoked
      if (err.error_code === 401) return true;
      // Check description against known fatal patterns
      const desc = err.description ?? "";
      return FATAL_ERROR_PATTERNS.some((p) => p.test(desc));
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
