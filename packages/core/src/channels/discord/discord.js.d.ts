/**
 * Ambient module declaration for the optional discord.js dependency.
 *
 * discord.js is loaded via dynamic import at runtime; this declaration
 * satisfies TypeScript without requiring the package to be installed.
 * Only the subset of the API actually used by discordjs-client.ts is typed.
 */
declare module "discord.js" {
  export class Client {
    constructor(options: { intents: number[] });
    login(token: string): Promise<string>;
    destroy(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): this;
    channels: {
      fetch(id: string): Promise<Record<string, unknown> | null>;
    };
    isReady(): boolean;
  }
  export const GatewayIntentBits: {
    readonly Guilds: number;
    readonly GuildMessages: number;
    readonly DirectMessages: number;
    readonly MessageContent: number;
    readonly [key: string]: number | undefined;
  };
  export const Events: {
    readonly MessageCreate: string;
    readonly [key: string]: string | undefined;
  };
}
