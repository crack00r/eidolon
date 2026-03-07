# Slack Channel Implementation Plan

## Summary

Add a Slack channel to Eidolon using `@slack/bolt`, following the established channel patterns
(Telegram via grammY, Discord via injectable `IDiscordClient`). The Slack channel will support
Socket Mode (no public HTTP endpoint needed), text messages, threads, reactions, file uploads,
slash commands (`/eidolon`), and an allowlist for authorized users and channels. An injectable
`ISlackClient` interface ensures testability without requiring Slack API access in tests.

Estimated effort: ~8 new files, ~1,200 lines of new code, ~4 files modified.

## Architecture Decision: Socket Mode vs. HTTP

**Recommendation: Socket Mode (primary), HTTP Events API (optional).**

Socket Mode uses WebSocket connections initiated from the bot, requiring no public-facing HTTP
endpoint. This aligns with Eidolon's Tailscale mesh topology where the daemon runs on an Ubuntu
server without a public IP. The `@slack/bolt` library supports both modes with a single
configuration flag (`socketMode: true`).

HTTP Events API can be added later if needed (e.g., for high-volume workspaces) by routing
through the existing Eidolon Gateway or a Cloudflare Tunnel.

## Files to Create

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `packages/core/src/channels/slack/channel.ts` | `SlackChannel` class implementing `Channel` | ~280 |
| `packages/core/src/channels/slack/bolt-client.ts` | Production `ISlackClient` adapter wrapping `@slack/bolt` | ~150 |
| `packages/core/src/channels/slack/bolt.d.ts` | Ambient module declaration for optional `@slack/bolt` dependency | ~30 |
| `packages/core/src/channels/slack/formatter.ts` | Markdown-to-Slack mrkdwn converter + message splitting (4000 char limit) | ~120 |
| `packages/core/src/channels/slack/index.ts` | Barrel exports | ~10 |
| `packages/core/src/channels/slack/__tests__/channel.test.ts` | Unit tests for SlackChannel with FakeSlackClient | ~250 |
| `packages/core/src/channels/slack/__tests__/formatter.test.ts` | Unit tests for mrkdwn formatting and splitting | ~100 |

## Files to Modify

| File | Change |
|------|--------|
| `packages/protocol/src/config.ts` | Add `SlackConfigSchema` and `slack` field to `ChannelConfigSchema` |
| `packages/core/src/channels/index.ts` | Add `export * from "./slack/index.ts"` |
| `packages/protocol/src/config.ts` | Update `DigestConfigSchema.channel` enum to include `"slack"` |
| `packages/core/package.json` | Add `@slack/bolt` as optional peer dependency |

## Interfaces and Types

### ISlackClient (injectable, mirrors the Discord pattern)

```typescript
/** Represents a Slack message for sending/receiving. */
export interface SlackMessage {
  readonly ts: string;          // Slack message timestamp (serves as message ID)
  readonly channel: string;     // Channel ID
  readonly text: string;
  readonly threadTs?: string;   // Thread parent timestamp
}

/** Represents a Slack user. */
export interface SlackUser {
  readonly id: string;
  readonly username: string;
  readonly isBot: boolean;
}

/** Represents a Slack file attachment. */
export interface SlackFile {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly urlPrivateDownload?: string;
}

/** Represents an inbound Slack event. */
export interface SlackInboundEvent {
  readonly type: "message" | "app_mention" | "slash_command" | "reaction";
  readonly ts: string;
  readonly channel: string;
  readonly user: SlackUser;
  readonly text: string;
  readonly threadTs?: string;
  readonly files?: readonly SlackFile[];
  readonly reactionName?: string;         // For reaction events
  readonly commandName?: string;          // For slash commands
  readonly responseUrl?: string;          // For slash command responses
}

/**
 * Injectable Slack client interface.
 * Production: BoltSlackClient wrapping @slack/bolt App.
 * Tests: FakeSlackClient recording all interactions.
 */
export interface ISlackClient {
  /** Start the Bolt app (Socket Mode or HTTP). */
  start(): Promise<void>;
  /** Stop the Bolt app. */
  stop(): Promise<void>;
  /** Register handler for incoming events. */
  onEvent(handler: (event: SlackInboundEvent) => Promise<void>): void;
  /** Post a message to a channel (optionally in a thread). */
  postMessage(channel: string, text: string, threadTs?: string): Promise<SlackMessage>;
  /** React to a message with an emoji. */
  addReaction(channel: string, ts: string, emoji: string): Promise<void>;
  /** Download a file by URL (uses bot token for auth). */
  downloadFile(url: string): Promise<Uint8Array>;
  /** Whether the client is connected. */
  isConnected(): boolean;
}
```

### SlackConfig

```typescript
export interface SlackConfig {
  readonly botToken: string;            // xoxb-... Bot User OAuth Token
  readonly appToken: string;            // xapp-... App-Level Token (for Socket Mode)
  readonly signingSecret: string;       // For verifying HTTP requests (if not using Socket Mode)
  readonly socketMode: boolean;         // default: true
  readonly allowedUserIds: readonly string[];     // Slack user IDs (e.g., "U01ABCDEF")
  readonly allowedChannelIds: readonly string[];  // Slack channel IDs (e.g., "C01ABCDEF")
  readonly respondInThread: boolean;    // default: true -- reply in threads to keep channels clean
}
```

### SlackConfigSchema (Zod, for config.ts)

```typescript
export const SlackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: SecretRefSchema.or(z.string()),
  appToken: SecretRefSchema.or(z.string()),
  signingSecret: SecretRefSchema.or(z.string()),
  socketMode: z.boolean().default(true),
  allowedUserIds: z.array(z.string()),
  allowedChannelIds: z.array(z.string()).default([]),   // empty = all channels allowed
  respondInThread: z.boolean().default(true),
});
```

## Implementation Steps

### Step 1: Config Schema Extension

**Scope**: `packages/protocol/src/config.ts`

1. Add `SlackConfigSchema` in the Channels section (after `EmailConfigSchema`).
2. Add `slack: SlackConfigSchema.optional()` to `ChannelConfigSchema`.
3. Update `DigestConfigSchema.channel` enum from `["telegram", "desktop", "all"]` to
   `["telegram", "desktop", "slack", "all"]`.
4. Export `SlackConfig` type at the bottom of the file.

### Step 2: Ambient Type Declaration

**Scope**: `packages/core/src/channels/slack/bolt.d.ts`

Create a minimal ambient module declaration for `@slack/bolt` (same pattern as `discord.js.d.ts`).
Only declare the subset of the API used by `bolt-client.ts`: `App` constructor, `start()`,
`stop()`, `message()`, `event()`, `command()`.

### Step 3: ISlackClient and SlackChannel

**Scope**: `packages/core/src/channels/slack/channel.ts`

Implement `SlackChannel` following the `DiscordChannel` pattern:

1. Implements `Channel` from `@eidolon/protocol`.
2. Constructor takes `SlackConfig`, `ISlackClient`, `Logger`, optional `ITracer`.
3. `capabilities`: text=true, markdown=true, images=true, documents=true, voice=false,
   reactions=true, editing=false (Slack supports editing but keeping it simple initially),
   streaming=false.
4. `connect()`: calls `client.start()`, registers event handler, returns `Result`.
5. `disconnect()`: calls `client.stop()`.
6. `send()`: formats markdown, splits at 4000 chars, calls `client.postMessage()`.
   Uses `respondInThread` config to decide whether to use `threadTs`.
7. `onMessage()`: stores handler callback.
8. Authorization: check `allowedUserIds` set + `allowedChannelIds` set (empty = all channels).
9. Rate limiting: same pattern as Telegram/Discord (30 msgs/60s per user).
10. Retry logic: same exponential backoff pattern (3 retries, transient error detection).
11. Inbound text truncation: 100KB max (same as other channels).

**Key differences from Telegram/Discord**:
- Slack uses `ts` (timestamp) as message ID, not integer IDs.
- Thread support is native via `threadTs`.
- Slash commands arrive as a separate event type with a `responseUrl`.
- Bot mentions (`@Eidolon`) arrive as `app_mention` events.

### Step 4: BoltSlackClient (Production Adapter)

**Scope**: `packages/core/src/channels/slack/bolt-client.ts`

Same pattern as `discordjs-client.ts`:

1. Dynamic import of `@slack/bolt` via variable-based path (avoid compile-time resolution).
2. Factory function `createBoltSlackClient(config)` returning `Result<ISlackClient, string>`.
3. Configures Bolt `App` with Socket Mode or HTTP based on config.
4. Maps Bolt events (`message`, `app_mention`, `command`) to `SlackInboundEvent`.
5. `downloadFile()` fetches file URLs with `Authorization: Bearer ${botToken}` header,
   enforces 25MB size limit and 30s timeout (same as Telegram media).
6. `postMessage()` uses Bolt's `client.chat.postMessage()`.
7. `addReaction()` uses Bolt's `client.reactions.add()`.

### Step 5: Markdown Formatter

**Scope**: `packages/core/src/channels/slack/formatter.ts`

Convert standard markdown (Claude output) to Slack mrkdwn:

| Standard Markdown | Slack mrkdwn |
|---|---|
| `**bold**` | `*bold*` |
| `_italic_` | `_italic_` (same) |
| `` `code` `` | `` `code` `` (same) |
| ```` ```lang\ncode``` ```` | ```` ```code``` ```` (Slack does not support language hints) |
| `~~strike~~` | `~strike~` |
| `[text](url)` | `<url\|text>` |
| `> quote` | `> quote` (same) |

Message splitting at 4000 characters (Slack's `chat.postMessage` limit), using the same
paragraph/line/hard-cut strategy as `splitMessage()` in the Telegram formatter.

Exported functions:
- `formatForSlack(markdown: string): string`
- `splitSlackMessage(text: string, maxLength?: number): string[]`

### Step 6: Barrel Exports and Channel Registration

**Scope**: `packages/core/src/channels/slack/index.ts` + `packages/core/src/channels/index.ts`

1. Create barrel `index.ts` exporting `SlackChannel`, `SlackConfig`, `ISlackClient`,
   `createBoltSlackClient`, `formatForSlack`, `splitSlackMessage`.
2. Add `export * from "./slack/index.ts"` to channels barrel.

### Step 7: Package Dependency

**Scope**: `packages/core/package.json`

Add `@slack/bolt` as an optional peer dependency (same approach as discord.js):

```json
"peerDependencies": {
  "@slack/bolt": "^4.0.0"
},
"peerDependenciesMeta": {
  "@slack/bolt": { "optional": true }
}
```

### Step 8: Tests

**Scope**: `packages/core/src/channels/slack/__tests__/`

#### channel.test.ts (~250 lines)

`FakeSlackClient` implementing `ISlackClient`:
- Records all `postMessage()` calls with arguments.
- Records all `addReaction()` calls.
- Allows simulating inbound events via `simulateEvent(event)`.
- Configurable failure modes (`shouldFailStart`, `shouldFailSend`).

Test cases (mirroring Discord channel.test.ts):
1. **Connection lifecycle**: connect/disconnect, double-connect is idempotent.
2. **Connect failure**: returns `Err` with `CHANNEL_AUTH_FAILED`.
3. **Inbound text message**: authorized user, handler receives `InboundMessage`.
4. **Inbound with thread**: `replyToId` is set to `threadTs`.
5. **Unauthorized user**: message is silently dropped with warning log.
6. **Unauthorized channel**: message from non-allowed channel is dropped.
7. **Bot message ignored**: messages from bots are skipped.
8. **Rate limiting**: 31st message in 60s is dropped.
9. **Outbound send**: formats and sends via `postMessage()`.
10. **Outbound markdown**: converts to Slack mrkdwn before sending.
11. **Outbound thread**: uses `respondInThread` config.
12. **Long message splitting**: messages >4000 chars are split.
13. **Send failure**: returns `Err` with `CHANNEL_SEND_FAILED`.
14. **Send when disconnected**: returns `Err`.
15. **Slash command**: `/eidolon` triggers inbound message with command text.
16. **App mention**: `@Eidolon do something` triggers inbound message.
17. **File attachment**: inbound message with file creates `MessageAttachment`.
18. **Inbound text truncation**: messages >100KB are truncated.

#### formatter.test.ts (~100 lines)

Test cases:
1. **Bold conversion**: `**text**` becomes `*text*`.
2. **Strikethrough**: `~~text~~` becomes `~text~`.
3. **Link conversion**: `[text](url)` becomes `<url|text>`.
4. **Code blocks**: language hint stripped, backticks preserved.
5. **Mixed formatting**: nested/combined formats.
6. **No-op on plain text**: plain text passes through unchanged.
7. **Message splitting**: at 4000 chars, respects paragraph boundaries.
8. **Short message**: no splitting needed, returns single-element array.

## Data Flow

```
Slack Workspace
    |
    | (WebSocket / Socket Mode)
    v
@slack/bolt App (BoltSlackClient)
    |
    | SlackInboundEvent
    v
SlackChannel.handleIncoming()
    |
    | 1. Check: is user in allowedUserIds?
    | 2. Check: is channel in allowedChannelIds? (if list non-empty)
    | 3. Check: rate limit OK?
    | 4. Build InboundMessage (with attachments if files present)
    |
    v
messageHandler callback
    |
    v
MessageRouter.routeInbound()
    |
    v
EventBus -> Cognitive Loop
    |
    | (response generated)
    v
MessageRouter.routeOutbound()
    |
    v
SlackChannel.send()
    |
    | 1. Format markdown -> mrkdwn
    | 2. Split if >4000 chars
    | 3. postMessage() with threadTs if respondInThread=true
    |
    v
BoltSlackClient.postMessage()
    |
    v
Slack API -> Workspace
```

## Slack App Setup Requirements

The user must create a Slack App in the Slack API dashboard with:

1. **Socket Mode**: enabled (generates App-Level Token `xapp-...`).
2. **Bot Token Scopes** (OAuth & Permissions):
   - `chat:write` -- send messages
   - `reactions:write` -- add reactions
   - `files:read` -- download shared files
   - `app_mentions:read` -- receive @mentions
   - `channels:history` -- read messages in public channels
   - `groups:history` -- read messages in private channels
   - `im:history` -- read DMs
   - `mpim:history` -- read group DMs
   - `commands` -- register slash commands
3. **Event Subscriptions** (Socket Mode handles these automatically):
   - `message.channels`, `message.groups`, `message.im`, `message.mpim`
   - `app_mention`
4. **Slash Commands**: register `/eidolon` with a description.
5. **Install to Workspace**: generates Bot User OAuth Token `xoxb-...`.

These tokens go into Eidolon's encrypted secrets store:
```bash
eidolon secrets set SLACK_BOT_TOKEN "xoxb-..."
eidolon secrets set SLACK_APP_TOKEN "xapp-..."
eidolon secrets set SLACK_SIGNING_SECRET "..."
```

Config reference:
```yaml
channels:
  slack:
    enabled: true
    botToken: { $secret: "SLACK_BOT_TOKEN" }
    appToken: { $secret: "SLACK_APP_TOKEN" }
    signingSecret: { $secret: "SLACK_SIGNING_SECRET" }
    socketMode: true
    allowedUserIds: ["U01ABCDEF"]
    allowedChannelIds: []          # empty = all channels
    respondInThread: true
```

## Allowlist Design

Two-level allowlist (consistent with Telegram/Discord patterns):

1. **User allowlist** (`allowedUserIds`): required, non-empty array of Slack user IDs.
   Only messages from these users are processed. All others are silently dropped with a
   warning log.

2. **Channel allowlist** (`allowedChannelIds`): optional, defaults to empty array.
   When empty, messages from any channel are accepted (subject to user allowlist).
   When non-empty, only messages from listed channel IDs are processed. DMs are always
   accepted regardless of this list (since DMs have no channel ID in the allowlist sense --
   they use the user's DM channel ID which the bot creates on first message).

Both lists use Slack's internal IDs (not display names) to prevent impersonation via
name changes.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `@slack/bolt` not installed | Dynamic import with graceful error (same as discord.js pattern) |
| Socket Mode WebSocket drops | Bolt handles reconnection automatically; channel detects disconnect via `isConnected()` |
| File download auth | Use bot token in Authorization header; enforce 25MB + 30s limits |
| Slack rate limits (Tier 1: 1 msg/sec) | Exponential backoff with retry; respect `Retry-After` header |
| Thread confusion | Always use `threadTs` from inbound message for responses; `respondInThread` config |
| Multiple workspaces | Out of scope for v1; single workspace per Eidolon instance |
| Slash command timeout (3 sec) | Acknowledge immediately, send actual response via `postMessage()` |

## Open Questions

1. **Slash command scope**: Should `/eidolon` accept arbitrary text (like a message) or have
   subcommands (e.g., `/eidolon status`, `/eidolon ask ...`)? Recommendation: treat the full
   text after `/eidolon` as a message to Eidolon, same as a DM.

2. **Feedback reactions**: Should Eidolon add reaction buttons (like Telegram's inline keyboard)
   for feedback? Slack does not have inline keyboards, but we could use Block Kit buttons or
   simply interpret user reactions (thumbs up/down emoji) on bot messages as feedback.
   Recommendation: defer to a follow-up; start with interpreting native emoji reactions.

3. **Channel vs. DM preference**: Should the bot respond only in DMs by default (like Discord's
   `dmOnly` mode) or in any allowed channel? Recommendation: respond wherever messaged, but
   always in threads when in channels (`respondInThread: true`).

4. **Unfurl control**: Should the bot suppress link unfurling in its responses? Slack auto-unfurls
   URLs which can be noisy. Recommendation: set `unfurl_links: false, unfurl_media: false` in
   `postMessage()` calls.
