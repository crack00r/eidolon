/**
 * Telegram feedback inline keyboard -- adds thumbs up/down buttons
 * to assistant responses for quick user feedback.
 *
 * The inline keyboard is attached to outgoing messages. When a user
 * clicks a rating button, the callback data is parsed and a feedback
 * submission is made through the FeedbackStore.
 *
 * Callback data format: "rate:<sessionId>:<rating>"
 * Example: "rate:sess-123:5" (thumbs up), "rate:sess-123:1" (thumbs down)
 */

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Logger } from "../../logging/logger.ts";
import type { FeedbackStore } from "../../feedback/store.ts";
import type { EventBus } from "../../loop/event-bus.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix for feedback callback data in inline keyboard buttons. */
const CALLBACK_PREFIX = "rate:";

/** Maximum length of sessionId in callback data to prevent abuse. */
const MAX_SESSION_ID_LENGTH = 128;

// ---------------------------------------------------------------------------
// Inline keyboard builder
// ---------------------------------------------------------------------------

/**
 * Create an InlineKeyboard with thumbs up/down rating buttons.
 *
 * @param sessionId  The session ID to associate with the feedback
 * @returns A grammy InlineKeyboard instance, or undefined if sessionId is invalid
 */
export function createFeedbackKeyboard(sessionId: string): InlineKeyboard | undefined {
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
    return undefined;
  }

  return new InlineKeyboard()
    .text("👍", `${CALLBACK_PREFIX}${sessionId}:5`)
    .text("👎", `${CALLBACK_PREFIX}${sessionId}:1`);
}

// ---------------------------------------------------------------------------
// Callback query handler registration
// ---------------------------------------------------------------------------

/**
 * Parse a feedback callback data string.
 * Returns null if the format is invalid.
 */
function parseFeedbackCallback(data: string): { sessionId: string; rating: number } | null {
  if (!data.startsWith(CALLBACK_PREFIX)) return null;

  const rest = data.slice(CALLBACK_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon === -1) return null;

  const sessionId = rest.slice(0, lastColon);
  const ratingStr = rest.slice(lastColon + 1);
  const rating = Number(ratingStr);

  if (!sessionId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return null;
  }

  return { sessionId, rating };
}

/**
 * Register a callback query handler on the bot that processes
 * feedback button clicks. Should be called once during bot setup.
 *
 * @param bot           The grammy Bot instance
 * @param feedbackStore The FeedbackStore for persisting ratings
 * @param eventBus      The EventBus for publishing feedback events
 * @param allowedUserIds Set of authorized Telegram user IDs
 * @param logger        Logger instance
 */
export function registerFeedbackCallbackHandler(deps: {
  bot: Bot;
  feedbackStore: FeedbackStore;
  eventBus: EventBus;
  allowedUserIds: ReadonlySet<number>;
  logger: Logger;
}): void {
  const { bot, feedbackStore, eventBus, allowedUserIds, logger } = deps;
  const log = logger.child("telegram-feedback");

  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !allowedUserIds.has(userId)) {
      await ctx.answerCallbackQuery({ text: "Unauthorized" });
      return;
    }

    const data = ctx.callbackQuery.data;
    const parsed = parseFeedbackCallback(data);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: "Invalid feedback data" });
      return;
    }

    const result = feedbackStore.submit({
      sessionId: parsed.sessionId,
      messageId: ctx.callbackQuery.message?.message_id
        ? String(ctx.callbackQuery.message.message_id)
        : undefined,
      rating: parsed.rating,
      channel: "telegram",
    });

    if (!result.ok) {
      log.error("callback", "Failed to submit feedback", result.error, {
        sessionId: parsed.sessionId,
        rating: parsed.rating,
        userId,
      });
      await ctx.answerCallbackQuery({ text: "Failed to save feedback" });
      return;
    }

    // Publish event for downstream processing (confidence adjustment, etc.)
    eventBus.publish(
      "user:feedback",
      {
        feedbackId: result.value.id,
        sessionId: result.value.sessionId,
        messageId: result.value.messageId,
        rating: result.value.rating,
        channel: result.value.channel,
      },
      { source: "telegram", priority: "normal" },
    );

    const emoji = parsed.rating >= 4 ? "👍" : "👎";
    await ctx.answerCallbackQuery({ text: `Feedback recorded ${emoji}` });

    // Remove the keyboard after rating to prevent duplicate submissions
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // Message may have been deleted or is too old to edit; non-fatal
    }

    log.info("callback", "Feedback recorded via inline keyboard", {
      feedbackId: result.value.id,
      sessionId: parsed.sessionId,
      rating: parsed.rating,
      userId,
    });
  });

  log.debug("register", "Feedback callback handler registered on bot");
}
