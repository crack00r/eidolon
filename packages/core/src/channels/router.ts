/**
 * MessageRouter: routes inbound messages to the EventBus and outbound messages to channels.
 *
 * Central routing hub that decouples message producers (channels) from consumers
 * (the Cognitive Loop via EventBus) and vice versa.
 *
 * Supports DND (Do Not Disturb) schedule enforcement for non-critical notifications.
 */

import type { Channel, EidolonError, InboundMessage, OutboundMessage, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";

// ---------------------------------------------------------------------------
// DND Schedule
// ---------------------------------------------------------------------------

export interface DndSchedule {
  /** DND start time in "HH:MM" 24h format. */
  readonly start: string;
  /** DND end time in "HH:MM" 24h format. */
  readonly end: string;
  /** Optional IANA timezone (e.g. "Europe/Berlin"). Falls back to local time if omitted. */
  readonly timezone?: string;
}

export type NotificationPriority = "critical" | "normal" | "low";

/**
 * Extract the current hour and minute in a given timezone using Intl.DateTimeFormat.
 * Returns the time components as minutes-since-midnight for easy comparison.
 */
function getMinutesInTimezone(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
  }
  // Intl may format midnight as 24 in some locales
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

/**
 * Check whether the current time falls within a DND window.
 * Handles windows that cross midnight (e.g. start=22:00, end=07:00).
 * When a timezone is specified in the schedule, the comparison uses
 * that timezone instead of the system's local time.
 * The `nowProvider` parameter is injectable for testing.
 */
export function isDndActive(schedule: DndSchedule, nowProvider?: () => Date): boolean {
  const now = nowProvider ? nowProvider() : new Date();

  let currentMinutes: number;
  if (schedule.timezone) {
    try {
      currentMinutes = getMinutesInTimezone(now, schedule.timezone);
    } catch {
      // Invalid timezone: fall back to local time
      currentMinutes = now.getHours() * 60 + now.getMinutes();
    }
  } else {
    currentMinutes = now.getHours() * 60 + now.getMinutes();
  }

  const [startH, startM] = schedule.start.split(":").map(Number);
  const [endH, endM] = schedule.end.split(":").map(Number);

  if (startH === undefined || startM === undefined || endH === undefined || endM === undefined) {
    return false;
  }

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day window: e.g. 09:00-17:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Cross-midnight window: e.g. 22:00-07:00
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

export interface MessageRouterOptions {
  /** DND schedule. When active, only 'critical' priority notifications are sent. */
  readonly dndSchedule?: DndSchedule;
  /** Injectable clock for testing DND. */
  readonly nowProvider?: () => Date;
}

export class MessageRouter {
  private readonly channels: Map<string, Channel> = new Map();
  private readonly eventBus: EventBus;
  private readonly logger: Logger;
  private readonly dndSchedule: DndSchedule | undefined;
  private readonly nowProvider: (() => Date) | undefined;

  constructor(eventBus: EventBus, logger: Logger, options?: MessageRouterOptions) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.dndSchedule = options?.dndSchedule;
    this.nowProvider = options?.nowProvider;
  }

  /** Register a channel for message routing. */
  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
    this.logger.info("router", `Registered channel: ${channel.id}`, { name: channel.name });
  }

  /** Unregister a channel by ID. */
  unregisterChannel(channelId: string): void {
    const removed = this.channels.delete(channelId);
    if (removed) {
      this.logger.info("router", `Unregistered channel: ${channelId}`);
    }
  }

  /**
   * Route an inbound message to the EventBus.
   * Publishes a `user:message` event with the InboundMessage as payload.
   */
  routeInbound(message: InboundMessage): Result<void, EidolonError> {
    this.logger.debug("router", `Routing inbound from ${message.channelId}`, {
      userId: message.userId,
      hasText: !!message.text,
    });

    const result = this.eventBus.publish(
      "user:message",
      {
        channelId: message.channelId,
        userId: message.userId,
        text: message.text ?? "",
        attachments: message.attachments?.map((a) => ({
          type: a.type,
          url: a.url ?? "",
        })),
      },
      { priority: "high", source: `channel:${message.channelId}` },
    );

    if (!result.ok) {
      return Err(result.error);
    }

    return Ok(undefined);
  }

  /**
   * Route an outbound message to the appropriate channel.
   * Looks up the channel by `message.channelId` and calls `channel.send()`.
   * This method is for direct user responses and always sends regardless of DND.
   */
  async routeOutbound(message: OutboundMessage): Promise<Result<void, EidolonError>> {
    const channel = this.channels.get(message.channelId);

    if (!channel) {
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, `No channel registered with ID: ${message.channelId}`));
    }

    this.logger.debug("router", `Routing outbound to ${message.channelId}`, {
      messageId: message.id,
    });

    return channel.send(message);
  }

  /**
   * Send a notification with DND awareness.
   * During DND, only 'critical' priority notifications are delivered.
   * 'normal' and 'low' priority notifications are suppressed with a log entry.
   *
   * Returns Ok(true) if sent, Ok(false) if suppressed by DND.
   */
  async sendNotification(
    message: OutboundMessage,
    priority: NotificationPriority = "normal",
  ): Promise<Result<boolean, EidolonError>> {
    // Check DND: only critical notifications bypass DND
    if (priority !== "critical" && this.dndSchedule) {
      if (isDndActive(this.dndSchedule, this.nowProvider)) {
        this.logger.info("router", `DND active: suppressing ${priority} notification to ${message.channelId}`, {
          messageId: message.id,
        });
        return Ok(false);
      }
    }

    const sendResult = await this.routeOutbound(message);
    if (!sendResult.ok) {
      return sendResult;
    }
    return Ok(true);
  }

  /** Get all registered channels. */
  getChannels(): readonly Channel[] {
    return [...this.channels.values()];
  }

  /** Get a channel by ID. */
  getChannel(id: string): Channel | undefined {
    return this.channels.get(id);
  }
}
