/**
 * DiscordJsClient: production adapter implementing IDiscordClient using discord.js.
 *
 * Wraps the discord.js Client so that DiscordChannel never depends on
 * discord.js directly, keeping the injectable IDiscordClient pattern intact.
 *
 * discord.js is loaded via a variable-based dynamic import to avoid
 * compile-time type resolution. This means the module loads gracefully
 * even when discord.js is not installed.
 */

import type {
  DiscordInboundMessage,
  DiscordMessage,
  IDiscordClient,
} from "./channel.ts";

// ---------------------------------------------------------------------------
// Minimal type shapes for the untyped discord.js objects we interact with.
// These are defined locally to avoid a compile-time dependency on discord.js.
// ---------------------------------------------------------------------------

/** Minimal shape of a discord.js Client instance. */
interface DjsClientLike {
  login(token: string): Promise<string>;
  destroy(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  channels: {
    fetch(id: string): Promise<DjsChannelLike | null>;
  };
  isReady(): boolean;
}

/** Minimal shape of a discord.js Message. */
interface DjsMessageLike {
  readonly id: string;
  readonly content: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly author: {
    readonly id: string;
    readonly username: string;
    readonly bot: boolean;
  };
  readonly attachments: {
    values(): Iterable<DjsAttachmentLike>;
  };
}

/** Minimal shape of a discord.js Attachment. */
interface DjsAttachmentLike {
  readonly id: string;
  readonly url: string;
  readonly name: string | null;
  readonly contentType: string | null;
  readonly size: number;
}

/** Minimal shape of a discord.js Channel with optional text capabilities. */
interface DjsChannelLike {
  send?(opts: { content: string }): Promise<{ id: string; content: string; channelId: string }>;
  messages?: {
    fetch(id: string): Promise<{
      edit(opts: { content: string }): Promise<{ id: string; content: string; channelId: string }>;
    }>;
  };
}

// discord.js GatewayIntentBits values (hardcoded to avoid compile-time dependency)
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;

/**
 * Create a DiscordJsClient by dynamically importing discord.js.
 *
 * Returns a Result-like object with the client instance or an error string.
 * The import uses a variable-based path so TypeScript does not attempt to
 * resolve discord.js types at compile time.
 */
export async function createDiscordJsClient(): Promise<
  { ok: true; client: IDiscordClient } | { ok: false; error: string }
> {
  // Use a variable for the module name to prevent TypeScript from resolving types
  const moduleName = "discord.js";

  let discordModule: Record<string, unknown>;
  try {
    discordModule = (await import(moduleName)) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `discord.js is not installed: ${msg}. Install it with: pnpm add discord.js`,
    };
  }

  try {
    const ClientCtor = discordModule.Client as new (opts: { intents: number[] }) => DjsClientLike;

    const djsClient = new ClientCtor({
      intents: [INTENT_GUILDS, INTENT_GUILD_MESSAGES, INTENT_DIRECT_MESSAGES, INTENT_MESSAGE_CONTENT],
    });

    const adapter: IDiscordClient = {
      async login(token: string): Promise<void> {
        await djsClient.login(token);
      },

      async destroy(): Promise<void> {
        await djsClient.destroy();
      },

      onMessage(handler: (message: DiscordInboundMessage) => Promise<void>): void {
        djsClient.on("messageCreate", async (...args: unknown[]) => {
          const m = args[0] as DjsMessageLike;

          const attachmentValues = [...m.attachments.values()];
          const attachments = attachmentValues.map((a) => ({
            id: String(a.id),
            url: String(a.url),
            filename: String(a.name ?? "unknown"),
            contentType: a.contentType,
            size: Number(a.size),
          }));

          const inbound: DiscordInboundMessage = {
            id: String(m.id),
            content: String(m.content ?? ""),
            channelId: String(m.channelId),
            author: {
              id: String(m.author.id),
              username: String(m.author.username),
              bot: Boolean(m.author.bot),
            },
            guildId: m.guildId ? String(m.guildId) : null,
            attachments,
          };

          await handler(inbound);
        });
      },

      async sendMessage(channelId: string, content: string): Promise<DiscordMessage> {
        const channel = await djsClient.channels.fetch(channelId);
        if (!channel || typeof channel.send !== "function") {
          throw new Error(`Channel ${channelId} not found or not a text channel`);
        }
        const sent = await channel.send({ content });
        return {
          id: String(sent.id),
          content: String(sent.content),
          channelId: String(sent.channelId),
        };
      },

      async editMessage(channelId: string, messageId: string, content: string): Promise<DiscordMessage> {
        const channel = await djsClient.channels.fetch(channelId);
        if (!channel?.messages || typeof channel.messages.fetch !== "function") {
          throw new Error(`Channel ${channelId} not found or not a text channel`);
        }
        const msg = await channel.messages.fetch(messageId);
        const edited = await msg.edit({ content });
        return {
          id: String(edited.id),
          content: String(edited.content),
          channelId: String(edited.channelId),
        };
      },

      isReady(): boolean {
        return typeof djsClient.isReady === "function" ? djsClient.isReady() : false;
      },
    };

    return { ok: true, client: adapter };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to create discord.js client: ${msg}`,
    };
  }
}
