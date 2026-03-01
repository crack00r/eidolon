/**
 * MessageRouter: routes inbound messages to the EventBus and outbound messages to channels.
 *
 * Central routing hub that decouples message producers (channels) from consumers
 * (the Cognitive Loop via EventBus) and vice versa.
 */

import type { Channel, EidolonError, InboundMessage, OutboundMessage, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";
import type { EventBus } from "../loop/event-bus.js";

export class MessageRouter {
  private readonly channels: Map<string, Channel> = new Map();
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  constructor(eventBus: EventBus, logger: Logger) {
    this.eventBus = eventBus;
    this.logger = logger;
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

  /** Get all registered channels. */
  getChannels(): readonly Channel[] {
    return [...this.channels.values()];
  }

  /** Get a channel by ID. */
  getChannel(id: string): Channel | undefined {
    return this.channels.get(id);
  }
}
