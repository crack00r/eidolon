# Channels

## Philosophy: Focused, Not Exhaustive

OpenClaw supports 15+ messaging channels. Most of them are fragile, poorly tested, and maintained by drive-by contributors. The result: setup instructions that don't work, edge cases everywhere, and a support burden that forced the project into "stabilization mode."

Eidolon takes the opposite approach: **start with one channel, get it perfect, then expand.**

## Channel Interface

All channels implement a common interface:

```typescript
interface Channel {
  id: string;                           // 'telegram', 'desktop', 'cli'
  name: string;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;

  // Messaging
  sendMessage(to: string, message: OutboundMessage): Promise<void>;
  sendVoice(to: string, audio: Buffer, format: AudioFormat): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;

  // Capabilities
  capabilities: {
    text: boolean;
    voice: boolean;
    images: boolean;
    files: boolean;
    reactions: boolean;
    editing: boolean;
    threads: boolean;
    typing: boolean;
  };
}

interface InboundMessage {
  id: string;
  channel: string;
  from: string;                         // Sender identifier
  text?: string;
  voice?: Buffer;                       // Raw audio
  images?: Attachment[];
  files?: Attachment[];
  replyTo?: string;                     // Reply to message ID
  timestamp: Date;
}

interface OutboundMessage {
  text?: string;
  voice?: Buffer;
  images?: Attachment[];
  files?: Attachment[];
  replyTo?: string;
  format?: 'text' | 'markdown' | 'html';
}
```

## Phase 1: Telegram (Primary)

### Why Telegram First

1. **Already in use.** The user runs OpenClaw on Telegram today.
2. **Rich bot API.** Text, voice, images, files, inline keyboards, commands.
3. **No phone pairing.** Unlike WhatsApp (Baileys), no need to pair a phone session.
4. **Reliable.** Telegram Bot API is stable and well-documented.
5. **grammY.** Battle-tested TypeScript framework, same as OpenClaw uses.
6. **Cross-platform.** Telegram works on every device.

### Implementation

```typescript
import { Bot, Context } from 'grammy';

class TelegramChannel implements Channel {
  private bot: Bot;
  private allowedUsers: Set<number>;

  async start(): Promise<void> {
    const token = await this.secrets.get('TELEGRAM_BOT_TOKEN');
    this.bot = new Bot(token);

    // Message handler
    this.bot.on('message:text', async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;

      this.emit('message', {
        id: String(ctx.message.message_id),
        channel: 'telegram',
        from: String(ctx.from.id),
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
      });
    });

    // Voice message handler
    this.bot.on('message:voice', async (ctx) => {
      if (!this.isAllowed(ctx.from?.id)) return;

      const file = await ctx.getFile();
      const audio = await this.downloadFile(file.file_path);

      this.emit('message', {
        id: String(ctx.message.message_id),
        channel: 'telegram',
        from: String(ctx.from.id),
        voice: audio,
        timestamp: new Date(ctx.message.date * 1000),
      });
    });

    // Commands
    this.bot.command('status', (ctx) => this.handleStatus(ctx));
    this.bot.command('new', (ctx) => this.handleNewSession(ctx));
    this.bot.command('memory', (ctx) => this.handleMemorySearch(ctx));

    await this.bot.start();
  }

  async sendMessage(to: string, message: OutboundMessage): Promise<void> {
    const chatId = Number(to);

    if (message.text) {
      // Split long messages (Telegram limit: 4096 chars)
      const chunks = this.splitMessage(message.text, 4096);
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: 'Markdown',
        });
      }
    }

    if (message.voice) {
      await this.bot.api.sendVoice(chatId, new InputFile(message.voice));
    }

    if (message.images) {
      for (const img of message.images) {
        await this.bot.api.sendPhoto(chatId, new InputFile(img.data));
      }
    }
  }
}
```

### Telegram Commands

| Command | Description |
|---|---|
| `/status` | Show daemon status, memory count, learning status |
| `/new` | Start a new session (reset context) |
| `/memory <query>` | Search memory |
| `/learn` | Show recent learning discoveries |
| `/approve <id>` | Approve a learning implementation |
| `/voice on/off` | Toggle voice responses |
| `/help` | List available commands |

### Configuration

```jsonc
{
  "channels": {
    "telegram": {
      "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" },
      "allowedUsers": [123456789],      // Telegram user IDs
      "mode": "polling",                 // 'polling' or 'webhook'
      "webhookUrl": null,                // For webhook mode
      "voiceResponses": false,           // Send TTS responses as voice messages
      "maxMessageLength": 4096,
      "typingIndicator": true            // Show "typing..." while processing
    }
  }
}
```

## Phase 2: Desktop Client (WebSocket)

See [Client Architecture](CLIENT_ARCHITECTURE.md). Desktop clients connect via WebSocket and are treated as both a channel (for sending/receiving messages) and a node (for executing commands on the local machine).

## Phase 3: Future Channels

Channels that could be added later, in order of priority:

| Priority | Channel | Rationale |
|---|---|---|
| 1 | **WhatsApp** | Most popular messenger. OpenClaw uses Baileys (reverse-engineered, fragile). Consider official WhatsApp Business API instead. |
| 2 | **Discord** | Popular in tech communities. discord.js is mature. |
| 3 | **Signal** | Privacy-focused. Requires signal-cli daemon. |
| 4 | **Slack** | Enterprise use. Bolt framework. |
| 5 | **Matrix** | Open protocol. Good for self-hosters. |
| 6 | **iMessage** | macOS only. BlueBubbles is the recommended approach. |

### Adding a Channel

Each channel is a self-contained module implementing the `Channel` interface. To add a new channel:

1. Create `packages/core/src/channels/<name>.ts`
2. Implement the `Channel` interface
3. Register in the Channel Manager
4. Add configuration schema
5. Add to CLI onboard wizard

No other code needs to change. The Cognitive Loop and Memory Engine are channel-agnostic.

## Message Routing

```
Inbound:
  Telegram/Desktop/CLI → Channel Manager → Event Bus → Cognitive Loop

Outbound:
  Cognitive Loop → Channel Manager → Route to originating channel
  (or: explicit channel override for cross-channel delivery)
```

### Multi-Channel Session

A single conversation can span multiple channels:

```
User sends via Telegram at desk
  → Response on Telegram

User opens Desktop app later
  → Same session continues
  → Full history visible

User asks Eidolon to "send to Telegram"
  → Message delivered to Telegram chat
```

Session identity is tied to the user, not the channel. The `session.dmScope: "main"` setting from OpenClaw is the default -- all direct messages share one session regardless of which channel they came from.
