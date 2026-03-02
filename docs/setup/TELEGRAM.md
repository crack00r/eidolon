# Telegram Bot Setup

Complete guide for setting up the Eidolon Telegram channel. The Telegram bot runs inside the brain server process and provides chat, voice messages, and notifications directly in Telegram.

## Overview

The Telegram bot is built with [grammy](https://grammy.dev/) and supports:

- Text messaging with Eidolon
- Voice messages (transcribed via GPU worker STT)
- Voice replies (generated via GPU worker TTS, sent as voice messages)
- Image and document processing
- Message reactions
- Authorized users only (whitelist by Telegram user ID)

## Step 1: Create a Bot via @BotFather

1. Open Telegram and search for **@BotFather**
2. Start a conversation and send `/newbot`
3. Follow the prompts:
   - **Name**: `Eidolon` (or your preferred display name)
   - **Username**: `your_eidolon_bot` (must end in `bot` and be unique)
4. BotFather will respond with your **bot token**:
   ```
   Done! Congratulations on your new bot. You will find it at t.me/your_eidolon_bot.
   Use this token to access the HTTP API:
   7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
5. Save this token — you will need it in the next step.

### Optional: Configure the Bot Profile

While still in @BotFather, send these commands to customize the bot:

```
/setdescription
→ Eidolon — Your personal AI assistant

/setabouttext
→ Autonomous AI assistant daemon. Private bot.

/setuserpic
→ (Upload an avatar image)

/setcommands
→ help - Show available commands
start - Start conversation
status - Show system status
memory - Search memory
voice - Toggle voice replies
```

## Step 2: Get Your Telegram User ID

The bot needs your Telegram user ID to authorize messages (not your username).

**Method 1: Use @userinfobot**
1. Search for **@userinfobot** in Telegram
2. Start a conversation
3. It replies with your user ID:
   ```
   Id: 123456789
   ```

**Method 2: Use the Telegram API**
- Forward any message from yourself to **@RawDataBot**

**Method 3: Check bot logs**
- Send a message to your bot, then check the Eidolon daemon logs — the sender's user ID will be logged.

## Step 3: Store the Bot Token

On the brain server, store the token in the encrypted secret store:

```bash
eidolon secrets set TELEGRAM_BOT_TOKEN
# Prompt: Enter value for TELEGRAM_BOT_TOKEN: 7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Step 4: Configure eidolon.json

Add or update the `channels.telegram` section in `~/.eidolon/eidolon.json`:

```jsonc
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" },
      "allowedUsers": [123456789],       // Your Telegram user ID(s)
      "mode": "polling",                 // 'polling' or 'webhook'
      "features": {
        "voice": true,                   // Process voice messages (requires GPU worker)
        "images": true,                  // Process image attachments
        "documents": true,               // Process document attachments
        "reactions": true                // React to messages
      }
    }
  }
}
```

### Multiple Authorized Users

To allow multiple people to use the bot, add their Telegram user IDs:

```jsonc
"allowedUsers": [123456789, 987654321, 555555555]
```

> **Security:** Only users in `allowedUsers` can interact with the bot. Messages from unauthorized users are silently ignored and logged in the audit trail.

### Polling vs. Webhook Mode

| Mode | Use Case | Configuration |
|---|---|---|
| **polling** | Default. Simple, works behind NAT/firewall. | No extra config needed. |
| **webhook** | Lower latency, better for high traffic. | Requires a public HTTPS endpoint. |

For most setups, **polling** is recommended. The bot periodically checks Telegram's servers for new messages.

For webhook mode:

```jsonc
{
  "channels": {
    "telegram": {
      "mode": "webhook",
      "webhook": {
        "url": "https://eidolon.yourdomain.com/telegram/webhook",
        "port": 8443,
        "certPath": "/path/to/cert.pem"
      }
    }
  }
}
```

## Step 5: Restart the Daemon

The Telegram channel configuration requires a daemon restart (not hot-reloadable):

```bash
eidolon daemon stop
eidolon daemon start

# Or with systemd:
sudo systemctl restart eidolon
```

## Step 6: Verify

### Check Channel Status

```bash
eidolon channel status
# Channels:
#   telegram: connected
#     Bot: @your_eidolon_bot
#     Mode: polling
#     Authorized users: 1
```

### Send a Test Message

1. Open Telegram and find your bot: `t.me/your_eidolon_bot`
2. Send `/start`
3. The bot should respond with a greeting
4. Send a text message — the bot should reply via Eidolon's cognitive loop

### Check Logs

```bash
# If running with systemd
journalctl -u eidolon --since "2 minutes ago" | grep telegram

# Or check the log file
tail -f ~/.eidolon/logs/daemon.log | grep telegram
```

Expected log entries:

```
[INFO] Telegram bot connected: @your_eidolon_bot
[INFO] Telegram polling started
[INFO] Telegram message from user 123456789: "Hello"
```

## Bot Commands and Usage

### Built-in Commands

| Command | Description |
|---|---|
| `/start` | Initialize conversation with the bot |
| `/help` | Show available commands |
| `/status` | Show Eidolon system status (uptime, memory, energy budget) |
| `/memory <query>` | Search the memory database |
| `/voice` | Toggle voice replies on/off |

### Text Messages

Any text message (without a command prefix) is processed as a conversation message through Eidolon's cognitive loop. The bot sends the response back as a text message.

### Voice Messages

When voice features are enabled and a GPU worker is configured:

1. **Sending voice**: Record a voice message in Telegram. The audio is forwarded to the GPU worker for transcription (faster-whisper). The transcribed text is processed as a regular message.
2. **Receiving voice**: If `/voice` is toggled on, Eidolon's text responses are also converted to voice messages via the GPU worker (Qwen3-TTS) and sent back in Telegram.

### Images and Documents

When enabled, images and documents attached to messages are processed:
- **Images**: Described or analyzed as part of the conversation context
- **Documents**: Text content extracted and included in the conversation

### Reactions

When enabled, the bot reacts to messages with appropriate emoji as acknowledgment before sending the full response.

## Advanced Configuration

### Custom Bot Commands

Add custom slash commands by extending the channel configuration. Custom commands are documented in the [Channels design doc](../design/CHANNELS.md).

### Rate Limiting

The bot respects Telegram's rate limits automatically. Additionally, Eidolon's energy budget applies — if the token budget is exhausted, the bot responds with a brief "resting" message.

### Privacy Mode

By default, the bot only receives messages addressed to it directly (private chat or messages starting with `/` in groups). This is Telegram's privacy mode and is the recommended setting.

## Troubleshooting

### Bot doesn't respond

1. Check that the daemon is running: `eidolon daemon status`
2. Check channel status: `eidolon channel status`
3. Verify the bot token is correct: the token format is `NUMBER:ALPHANUMERIC`
4. Verify your user ID is in `allowedUsers`
5. Check daemon logs for errors

### "Unauthorized" in logs

```
[WARN] Telegram: unauthorized message from user 999999999
```

Add the user's ID to `allowedUsers` in `eidolon.json` and restart.

### Bot token invalid

```
[ERROR] Telegram: 401 Unauthorized - bot token is invalid
```

- Verify the token with BotFather: send `/token` to @BotFather, select your bot
- Re-store the token: `eidolon secrets set TELEGRAM_BOT_TOKEN`
- Restart the daemon

### Voice messages not working

- Voice requires a configured [GPU Worker](GPU_WORKER.md) with STT/TTS capabilities
- Check GPU worker health: `eidolon doctor`
- Verify `features.voice` is `true` in the Telegram config

### Webhook mode not receiving messages

- Ensure the webhook URL is publicly accessible via HTTPS
- Verify the SSL certificate is valid
- Check that Telegram can reach your server (no firewall blocking)
- Try switching to polling mode to isolate the issue

### Bot shows "typing" forever

- The cognitive loop may be processing a complex request
- Check energy budget: `eidolon daemon status` — if tokens are exhausted, the bot queues messages
- Check Claude Code process health in the logs

## Next Steps

- [Server Setup](SERVER.md) — brain server configuration
- [GPU Worker Setup](GPU_WORKER.md) — enable voice messages
- [Network Guide](NETWORK.md) — connectivity for webhook mode
