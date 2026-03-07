/**
 * Ambient module declaration for the optional @slack/bolt dependency.
 *
 * @slack/bolt is loaded via dynamic import at runtime; this declaration
 * satisfies TypeScript without requiring the package to be installed.
 * Only the subset of the API actually used by bolt-client.ts is typed.
 */
declare module "@slack/bolt" {
  export interface AppOptions {
    token?: string;
    appToken?: string;
    signingSecret?: string;
    socketMode?: boolean;
  }

  export interface SlackEventMiddlewareArgs {
    event: {
      type: string;
      text?: string;
      ts: string;
      channel: string;
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
    };
  }

  export interface SlackCommandMiddlewareArgs {
    command: {
      command: string;
      text: string;
      channel_id: string;
      user_id: string;
      response_url: string;
      trigger_id: string;
    };
    ack: () => Promise<void>;
  }

  export class App {
    constructor(options: AppOptions);
    start(port?: number): Promise<void>;
    stop(): Promise<void>;
    message(handler: (args: SlackEventMiddlewareArgs & { say: (text: string) => Promise<void> }) => Promise<void>): void;
    event(eventType: string, handler: (args: SlackEventMiddlewareArgs) => Promise<void>): void;
    command(
      commandName: string,
      handler: (args: SlackCommandMiddlewareArgs) => Promise<void>,
    ): void;
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
}
