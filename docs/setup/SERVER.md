# Server Setup — Ubuntu

Complete guide for setting up the Eidolon brain/core daemon on an Ubuntu server.

## System Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8+ GB |
| Disk | 20 GB | 50+ GB (memory DB grows over time) |
| [Bun](https://bun.sh/) | 1.1+ | Latest |
| [Node.js](https://nodejs.org/) | 22+ | LTS |
| [pnpm](https://pnpm.io/) | 9+ | Latest |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Latest | Latest |
| [Tailscale](https://tailscale.com/) | Latest | Latest |

## Installation

### 1. Install System Dependencies

```bash
# Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Node.js (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
corepack enable
corepack prepare pnpm@latest --activate

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

### 2. Clone and Build

```bash
git clone https://github.com/crack00r/eidolon.git /opt/eidolon
cd /opt/eidolon
pnpm install
pnpm -r build
```

Verify the build:

```bash
pnpm -r test
# Expected: 522 tests passing
```

### 3. Create System User (Production)

For production deployments, run the daemon under a dedicated user:

```bash
sudo useradd --system --create-home --home-dir /var/lib/eidolon --shell /usr/sbin/nologin eidolon
sudo mkdir -p /var/lib/eidolon /var/log/eidolon /etc/eidolon
sudo chown eidolon:eidolon /var/lib/eidolon /var/log/eidolon /etc/eidolon
```

## Initial Setup

### 4. Run the Onboard Wizard

The interactive onboard wizard creates your initial configuration:

```bash
eidolon onboard
```

This will:
- Create `~/.eidolon/eidolon.json` with your preferences
- Set your identity (name, timezone, locale)
- Configure Claude Code account(s)
- Set up the gateway port and auth token
- Optionally configure Telegram and GPU workers

For production with the system user:

```bash
sudo -u eidolon EIDOLON_DATA_DIR=/var/lib/eidolon eidolon onboard
```

### 5. Configure Secrets

The secret store uses AES-256-GCM encryption with scrypt key derivation. On first use, you will set a master passphrase:

```bash
# Set your Anthropic API key (if using API key auth)
eidolon secrets set ANTHROPIC_API_KEY
# Prompt: Enter value for ANTHROPIC_API_KEY: ****

# Set the gateway auth token (clients use this to connect)
eidolon secrets set GATEWAY_TOKEN
# Prompt: Enter value for GATEWAY_TOKEN: ****

# Optional: Telegram bot token
eidolon secrets set TELEGRAM_BOT_TOKEN

# Optional: GPU worker API key
eidolon secrets set GPU_API_KEY
```

Secrets are stored in `~/.eidolon/secrets.enc` (encrypted). They are referenced in `eidolon.json` via `{ "$secret": "KEY_NAME" }` and resolved at runtime.

### 6. Minimal Configuration

If you skipped the onboard wizard, create `~/.eidolon/eidolon.json` manually:

```jsonc
{
  "identity": {
    "name": "Eidolon",
    "timezone": "Europe/Berlin",
    "locale": "de-DE",
    "owner": { "name": "Manuel" }
  },
  "brain": {
    "accounts": [
      { "type": "oauth", "name": "main" }
    ]
  },
  "gateway": {
    "enabled": true,
    "port": 8419,
    "authToken": { "$secret": "GATEWAY_TOKEN" }
  }
}
```

See [Configuration Reference](../reference/CONFIGURATION.md) for all options.

## Database

Databases are auto-created on first daemon start. No manual initialization needed. The 3-database split is:

| Database | Purpose | Default Path |
|---|---|---|
| `memory.db` | Memory engine (episodic, semantic, KG) | `~/.eidolon/memory.db` |
| `operational.db` | Sessions, event bus, task queue | `~/.eidolon/operational.db` |
| `audit.db` | Audit trail, action log | `~/.eidolon/audit.db` |

All databases use WAL mode for concurrent reads.

## Starting the Daemon

### Development (Foreground)

```bash
eidolon daemon start --foreground
# [INFO] Eidolon daemon starting...
# [INFO] Configuration loaded from ~/.eidolon/eidolon.json
# [INFO] Databases initialized
# [INFO] Gateway listening on 0.0.0.0:8419
# [INFO] Cognitive loop active
```

### Production (systemd)

Copy the service files from the repository:

```bash
sudo cp /opt/eidolon/deploy/eidolon.service /etc/systemd/system/
sudo cp /opt/eidolon/deploy/eidolon-backup.service /etc/systemd/system/
sudo cp /opt/eidolon/deploy/eidolon-backup.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable eidolon
sudo systemctl start eidolon

# Enable daily backups (runs at 03:00)
sudo systemctl enable eidolon-backup.timer
sudo systemctl start eidolon-backup.timer
```

The systemd service includes security hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, capability bounding, and restricted namespaces. See `deploy/eidolon.service` for full details.

### Background (Daemon Mode)

```bash
eidolon daemon start
# Eidolon daemon started (PID: 12345)

eidolon daemon stop
# Eidolon daemon stopped

eidolon daemon status
# Status: running
# PID: 12345
# Uptime: 2h 15m
# Gateway: 0.0.0.0:8419 (3 connections)
# Memory: 245 MB RSS
```

## Verification

### Health Check

```bash
eidolon doctor
# ✓ Bun 1.1.42
# ✓ Claude Code CLI 1.2.3
# ✓ Configuration valid
# ✓ Secret store accessible
# ✓ Databases writable
# ✓ Gateway port 8419 available
# ✓ Tailscale connected (100.x.x.x)
# ✓ GPU worker reachable (windows-pc.tailnet.ts.net:8420)
# ✓ Telegram bot token valid
```

### Test Gateway Connectivity

From another machine on the Tailscale network:

```bash
# Using websocat or similar WebSocket client
websocat ws://ubuntu-server.tailnet.ts.net:8419
```

## Firewall Configuration

Open the gateway port only on the Tailscale interface:

```bash
# Allow gateway traffic from Tailscale only
sudo ufw allow in on tailscale0 to any port 8419

# Verify
sudo ufw status
# 8419    ALLOW IN    Anywhere on tailscale0
```

Do **not** expose port 8419 on public interfaces. All client connections go through Tailscale.

See [Network Setup](NETWORK.md) for the full network configuration guide.

## Updating

```bash
cd /opt/eidolon
git pull
pnpm install
pnpm -r build

# If running via systemd:
sudo systemctl restart eidolon
```

## Troubleshooting

### Daemon won't start

```bash
# Check logs
journalctl -u eidolon --since "5 minutes ago"

# Or foreground mode for direct output
eidolon daemon start --foreground
```

### Configuration errors

```bash
eidolon config validate
# Error: brain.accounts: At least one account is required
```

### Port already in use

```bash
# Check what's using port 8419
sudo ss -tlnp | grep 8419

# Use a different port
export EIDOLON_GATEWAY__PORT=8420
```

### Claude Code authentication

```bash
# Verify Claude Code CLI works
claude --version

# Re-authenticate
claude auth login
```

### Secret store locked

```bash
# Verify you can access secrets
eidolon secrets list
# If prompted for passphrase and it fails, you may need to recreate:
# WARNING: This deletes all stored secrets
rm ~/.eidolon/secrets.enc
eidolon secrets set ANTHROPIC_API_KEY
```

### Database corruption

```bash
# Run integrity check
eidolon doctor --check-db

# Restore from backup
cp /var/lib/eidolon/backups/latest/*.db /var/lib/eidolon/
sudo systemctl restart eidolon
```

## CLI Commands Reference

| Command | Description |
|---|---|
| `eidolon onboard` | Interactive setup wizard |
| `eidolon daemon start` | Start the daemon |
| `eidolon daemon stop` | Stop the daemon |
| `eidolon daemon status` | Show daemon status |
| `eidolon config show` | Display current config |
| `eidolon config validate` | Validate config file |
| `eidolon config reload` | Hot-reload config |
| `eidolon secrets set KEY` | Store a secret |
| `eidolon secrets list` | List stored secret keys |
| `eidolon doctor` | System health check |
| `eidolon memory search QUERY` | Search memory |
| `eidolon learning status` | Show learning pipeline status |
| `eidolon chat` | Interactive chat session |
| `eidolon channel status` | Show channel statuses |
| `eidolon privacy export` | GDPR data export |
| `eidolon privacy delete` | GDPR data deletion |

## Next Steps

- [GPU Worker Setup](GPU_WORKER.md) — configure TTS/STT on a GPU machine
- [Desktop Client](DESKTOP.md) — install the Tauri desktop app
- [Telegram Bot](TELEGRAM.md) — set up the Telegram channel
- [Network Guide](NETWORK.md) — Tailscale and connectivity
- [Quick Start](QUICKSTART.md) — single-machine setup in 10 minutes
