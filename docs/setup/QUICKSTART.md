# Quick Start

Get Eidolon running on a single machine in 10 minutes. This guide covers the minimal setup to have the brain server, a client, and optionally Telegram working on one computer.

For multi-device setups, see the dedicated guides linked at the bottom.

## Prerequisites

Install these before starting:

| Tool | Install Command |
|---|---|
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` |
| [Node.js 22+](https://nodejs.org/) | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` |
| [pnpm 9+](https://pnpm.io/) | `corepack enable && corepack prepare pnpm@latest --activate` |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | `npm install -g @anthropic-ai/claude-code` |

Verify installations:

```bash
bun --version      # >= 1.1
node --version     # >= 22
pnpm --version     # >= 9
claude --version   # any
```

## Step 1: Clone and Build

```bash
git clone https://github.com/crack00r/eidolon.git
cd eidolon
pnpm install
pnpm -r build
```

Expected: clean build with no errors.

## Step 2: Authenticate Claude Code

If you haven't already, authenticate the Claude Code CLI:

```bash
# OAuth (recommended — free with usage limits)
claude auth login

# Or set an API key
export ANTHROPIC_API_KEY=sk-ant-...
```

## Step 3: Run the Onboard Wizard

```bash
eidolon onboard
```

The wizard first checks prerequisites (Bun runtime, Claude Code CLI, data/config/log directories), then walks you through setup based on the role you choose.

### Wizard Steps (Brain Server)

1. **Role Selection** — choose **Brain Server** (runs the AI daemon) or **Client Only** (connects to an existing server)
2. **Identity** — enter the owner name
3. **Security** — generate or provide a master encryption key (AES-256-GCM, used to encrypt all secrets)
4. **Claude Account** — optionally enter a Claude API key (otherwise OAuth is used)
5. **Gateway Setup** — port (default: `8419`), auto-generated or manual auth token, TLS toggle, bind address (`0.0.0.0` or `127.0.0.1`)
6. **Network Discovery** — enable/disable UDP broadcast so clients can auto-discover the server; Tailscale IP is auto-detected if available
7. **Channels** — optionally enter a Telegram bot token and/or GPU worker URL
8. **Platform Service** — optionally install as a systemd/launchd service for auto-start on boot
9. **Doctor Checks** — validates the generated configuration
10. **Summary** — shows gateway URL, discovery status, and a **pairing URL** (`eidolon://host:port?token=...&tls=...`) for connecting clients

### Wizard Steps (Client Only)

1. **Auto-Discovery** — listens for UDP broadcast beacons for 5 seconds and lists any discovered servers
2. **Select or Enter Manually** — pick a discovered server or enter a `host:port` address manually
3. **Auth Token** — enter the gateway auth token provided by the server operator

After setup, the config is written to `~/.eidolon/eidolon.json`.

### Minimal Manual Config (Alternative)

If you prefer to skip the wizard, create the config manually:

```bash
mkdir -p ~/.eidolon
cat > ~/.eidolon/eidolon.json << 'EOF'
{
  "identity": {
    "name": "Eidolon",
    "ownerName": "Manuel"
  },
  "brain": {
    "accounts": [
      { "type": "oauth", "name": "primary", "credential": "oauth", "priority": 50 }
    ]
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": 8419,
    "tls": { "enabled": false },
    "auth": { "type": "token", "token": { "$secret": "gateway-auth-token" } }
  },
  "database": {},
  "logging": { "level": "info", "format": "pretty" },
  "daemon": {}
}
EOF
```

## Step 4: Set Up Secrets

If you used the onboard wizard, secrets (master key, gateway token, API key) were already encrypted and stored during setup. You only need to ensure the master key is available at runtime:

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
export EIDOLON_MASTER_KEY=<your-master-key>
```

To add or change secrets manually:

```bash
# Gateway auth token (clients use this to connect)
eidolon secrets set GATEWAY_TOKEN
# Enter a strong random token, e.g.: $(openssl rand -base64 32)

# If using API key auth for Claude:
eidolon secrets set ANTHROPIC_API_KEY
```

## Step 5: Start the Daemon

```bash
eidolon daemon start --foreground
```

Expected output:

```
[INFO] Eidolon daemon starting...
[INFO] Configuration loaded from ~/.eidolon/eidolon.json
[INFO] Databases initialized (memory.db, operational.db, audit.db)
[INFO] Gateway listening on 0.0.0.0:8419
[INFO] Cognitive loop active
[INFO] Eidolon is ready
```

Leave this running and open a new terminal for the next steps.

## Step 6: Verify

```bash
eidolon daemon status
# Status: running
# PID: 12345
# Gateway: 0.0.0.0:8419

eidolon doctor
# ✓ Bun 1.1.x
# ✓ Claude Code CLI
# ✓ Configuration valid
# ✓ Secret store accessible
# ✓ Databases writable
# ✓ Gateway port 8419 available
```

## Step 7: Chat

Start an interactive chat session:

```bash
eidolon chat
# Connected to Eidolon
# Type a message (Ctrl+C to exit):
#
# > Hello, Eidolon!
# Hello! I'm Eidolon, your AI assistant. How can I help you?
```

## Step 8: Connect a Client (Optional)

### Web Dashboard

In a separate terminal:

```bash
pnpm --filter @eidolon/web dev
# ➜ Local: http://localhost:5173/
```

Open `http://localhost:5173` in your browser. Enter:
- Server: `localhost`
- Port: `8419`
- Token: (the GATEWAY_TOKEN you set earlier)

### Desktop Client

If you have Rust and Tauri CLI installed:

```bash
cd apps/desktop
cargo tauri dev
```

Enter `localhost:8419` and your gateway token in the connection settings.

## Step 9: Add Telegram (Optional)

1. Create a bot via [@BotFather](https://t.me/BotFather) in Telegram (send `/newbot`)
2. Store the token:
   ```bash
   eidolon secrets set TELEGRAM_BOT_TOKEN
   ```
3. Get your Telegram user ID (send a message to [@userinfobot](https://t.me/userinfobot))
4. Edit `~/.eidolon/eidolon.json`:
   ```jsonc
   {
     "channels": {
       "telegram": {
         "enabled": true,
         "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" },
         "allowedUsers": [YOUR_USER_ID],
         "mode": "polling"
       }
     }
   }
   ```
5. Restart the daemon:
   ```bash
   eidolon daemon stop
   eidolon daemon start --foreground
   ```
6. Send a message to your bot in Telegram — it should reply.

See [Telegram Setup](TELEGRAM.md) for the full guide.

## What's Running

After completing this guide, you have:

| Component | Location | Status |
|---|---|---|
| Brain/Core daemon | localhost | Running, cognitive loop active |
| WebSocket Gateway | localhost:8419 | Accepting client connections |
| Databases | ~/.eidolon/*.db | Auto-created, WAL mode |
| Secret store | ~/.eidolon/secrets.enc | Encrypted with your passphrase |
| Web dashboard | localhost:5173 | (if started) Dev server |
| Telegram bot | (if configured) | Polling for messages |

## What's NOT Running (Yet)

| Component | Needed For | Guide |
|---|---|---|
| GPU Worker | Voice (TTS/STT) | [GPU Worker Setup](GPU_WORKER.md) |
| Tailscale | Multi-device access | [Network Guide](NETWORK.md) |
| systemd service | Auto-start on boot | [Server Setup](SERVER.md) |
| Desktop installer | Production desktop app | [Desktop Setup](DESKTOP.md) |
| iOS app | iPhone/iPad access | [iOS Setup](IOS.md) |

## Common Issues

### "Command not found: eidolon"

The CLI is not in your PATH. Run it directly:

```bash
bun packages/cli/src/index.ts daemon start --foreground
```

Or link it:

```bash
pnpm --filter @eidolon/cli link --global
```

### "Port 8419 already in use"

```bash
# Find what's using the port
ss -tlnp | grep 8419

# Use a different port
EIDOLON_GATEWAY__PORT=8420 eidolon daemon start --foreground
```

### "Claude Code authentication failed"

```bash
# Re-authenticate
claude auth login

# Or check API key
echo $ANTHROPIC_API_KEY
```

### Configuration validation error

```bash
eidolon config validate
# Shows specific errors to fix
```

### Web dashboard can't connect

- Ensure the daemon is running: `eidolon daemon status`
- Check the port matches (default: 8419)
- Check the auth token is correct

## Next Steps

Once the basics work, expand to a multi-device setup:

1. **[Server Setup](SERVER.md)** — production systemd service, backup timer, security hardening
2. **[Network Guide](NETWORK.md)** — Tailscale mesh VPN for multi-device access
3. **[GPU Worker](GPU_WORKER.md)** — enable voice (TTS/STT) on a GPU machine
4. **[Desktop Client](DESKTOP.md)** — install the native desktop app
5. **[iOS Client](IOS.md)** — build and run the iPhone app
6. **[Telegram Bot](TELEGRAM.md)** — full Telegram channel configuration
7. **[Web Dashboard](WEB.md)** — production deployment with HTTPS
