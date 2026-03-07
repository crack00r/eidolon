/**
 * BoltSlackClient: production adapter implementing ISlackClient using @slack/bolt.
 *
 * Wraps the @slack/bolt App so that SlackChannel never depends on
 * @slack/bolt directly, keeping the injectable ISlackClient pattern intact.
 *
 * @slack/bolt is loaded via a variable-based dynamic import to avoid
 * compile-time type resolution. This means the module loads gracefully
 * even when @slack/bolt is not installed.
 */

import type { ISlackClient, SlackConfig, SlackInboundEvent, SlackMessage, SlackUser } from "./channel.ts";

// ---------------------------------------------------------------------------
// Minimal type shapes for the untyped @slack/bolt objects we interact with.
// ---------------------------------------------------------------------------

interface BoltAppLike {
  start(port?: number): Promise<void>;
  stop(): Promise<void>;
  message(handler: (args: Record<string, unknown>) => Promise<void>): void;
  event(eventType: string, handler: (args: Record<string, unknown>) => Promise<void>): void;
  command(commandName: string, handler: (args: Record<string, unknown>) => Promise<void>): void;
  client: {
    chat: {
      postMessage(args: {
        channel: string;
        text: string;
        thread_ts?: string;
        unfurl_links?: boolean;
        unfurl_media?: boolean;
      }): Promise<{ ok: boolean; ts?: string; channel?: string; message?: { text?: string } }>;
    };
    reactions: {
      add(args: { channel: string; timestamp: string; name: string }): Promise<{ ok: boolean }>;
    };
    users: {
      info(args: { user: string }): Promise<{
        ok: boolean;
        user?: { id: string; name: string; is_bot: boolean };
      }>;
    };
  };
}

interface BoltEventPayload {
  type?: string;
  text?: string;
  ts?: string;
  channel?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  files?: ReadonlyArray<{
    id: string;
    name: string;
    mimetype: string;
    size: number;
    url_private_download?: string;
  }>;
}

interface BoltCommandPayload {
  command?: string;
  text?: string;
  channel_id?: string;
  user_id?: string;
  response_url?: string;
}

/** Maximum file download size (25 MB). */
const MAX_FILE_SIZE = 25 * 1024 * 1024;
/** File download timeout (30 seconds). */
const FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Create a BoltSlackClient by dynamically importing @slack/bolt.
 *
 * Returns a Result-like object with the client instance or an error string.
 */
export async function createBoltSlackClient(
  config: SlackConfig,
): Promise<{ ok: true; client: ISlackClient } | { ok: false; error: string }> {
  const moduleName = "@slack/bolt";

  let boltModule: Record<string, unknown>;
  try {
    boltModule = (await import(moduleName)) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `@slack/bolt is not installed: ${msg}. Install it with: pnpm add @slack/bolt`,
    };
  }

  try {
    const AppCtor = boltModule.App as new (opts: Record<string, unknown>) => BoltAppLike;

    const app = new AppCtor({
      token: config.botToken,
      appToken: config.appToken,
      signingSecret: config.signingSecret,
      socketMode: config.socketMode,
    });

    let eventHandler: ((event: SlackInboundEvent) => Promise<void>) | null = null;
    let connected = false;

    // User info cache to avoid repeated API calls
    const userCache = new Map<string, SlackUser>();

    async function resolveUser(userId: string): Promise<SlackUser> {
      const cached = userCache.get(userId);
      if (cached) return cached;

      try {
        const result = await app.client.users.info({ user: userId });
        if (result.ok && result.user) {
          const user: SlackUser = {
            id: result.user.id,
            username: result.user.name,
            isBot: result.user.is_bot,
          };
          userCache.set(userId, user);
          return user;
        }
      } catch {
        // Fall through to default
      }

      return { id: userId, username: userId, isBot: false };
    }

    // Register message handler
    app.message(async (args: Record<string, unknown>) => {
      if (!eventHandler) return;
      const event = args.event as BoltEventPayload | undefined;
      if (!event?.user || event.bot_id) return;

      const user = await resolveUser(event.user);
      const inbound: SlackInboundEvent = {
        type: "message",
        ts: event.ts ?? "",
        channel: event.channel ?? "",
        user,
        text: event.text ?? "",
        threadTs: event.thread_ts,
        files: event.files?.map((f) => ({
          id: f.id,
          name: f.name,
          mimetype: f.mimetype,
          size: f.size,
          urlPrivateDownload: f.url_private_download,
        })),
      };
      await eventHandler(inbound);
    });

    // Register app_mention handler
    app.event("app_mention", async (args: Record<string, unknown>) => {
      if (!eventHandler) return;
      const event = args.event as BoltEventPayload | undefined;
      if (!event?.user || event.bot_id) return;

      const user = await resolveUser(event.user);
      const inbound: SlackInboundEvent = {
        type: "app_mention",
        ts: event.ts ?? "",
        channel: event.channel ?? "",
        user,
        text: event.text ?? "",
        threadTs: event.thread_ts,
      };
      await eventHandler(inbound);
    });

    // Register /eidolon slash command
    app.command("/eidolon", async (args: Record<string, unknown>) => {
      if (!eventHandler) return;
      const ackFn = args.ack as (() => Promise<void>) | undefined;
      if (ackFn) await ackFn(); // Acknowledge within 3 seconds

      const command = args.command as BoltCommandPayload | undefined;
      if (!command?.user_id) return;

      const user = await resolveUser(command.user_id);
      const inbound: SlackInboundEvent = {
        type: "slash_command",
        ts: `cmd-${Date.now()}`,
        channel: command.channel_id ?? "",
        user,
        text: command.text ?? "",
        commandName: command.command,
        responseUrl: command.response_url,
      };
      await eventHandler(inbound);
    });

    const adapter: ISlackClient = {
      async start(): Promise<void> {
        await app.start();
        connected = true;
      },

      async stop(): Promise<void> {
        await app.stop();
        connected = false;
      },

      onEvent(handler: (event: SlackInboundEvent) => Promise<void>): void {
        eventHandler = handler;
      },

      async postMessage(channel: string, text: string, threadTs?: string): Promise<SlackMessage> {
        const result = await app.client.chat.postMessage({
          channel,
          text,
          thread_ts: threadTs,
          unfurl_links: false,
          unfurl_media: false,
        });

        return {
          ts: result.ts ?? "",
          channel: result.channel ?? channel,
          text: result.message?.text ?? text,
          threadTs: threadTs,
        };
      },

      async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
        await app.client.reactions.add({
          channel,
          timestamp: ts,
          name: emoji,
        });
      },

      async downloadFile(url: string): Promise<Uint8Array> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FILE_DOWNLOAD_TIMEOUT_MS);

        try {
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${config.botToken}` },
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`File download failed: ${response.status} ${response.statusText}`);
          }

          const contentLength = response.headers.get("content-length");
          if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${contentLength} bytes exceeds ${MAX_FILE_SIZE} limit`);
          }

          const buffer = await response.arrayBuffer();
          if (buffer.byteLength > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${buffer.byteLength} bytes exceeds ${MAX_FILE_SIZE} limit`);
          }

          return new Uint8Array(buffer);
        } finally {
          clearTimeout(timeout);
        }
      },

      isConnected(): boolean {
        return connected;
      },
    };

    return { ok: true, client: adapter };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to create @slack/bolt client: ${msg}`,
    };
  }
}
