/**
 * Discord channel type definitions -- extracted from channel.ts.
 *
 * Interfaces for the injectable Discord client, message types,
 * and channel configuration.
 */

// ---------------------------------------------------------------------------
// Discord message & user types
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

// ---------------------------------------------------------------------------
// Injectable Discord client interface
// ---------------------------------------------------------------------------

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
