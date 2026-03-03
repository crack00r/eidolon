# Ubuntu / Debian Server Setup Guide

This guide walks through setting up Eidolon as a production daemon on an Ubuntu server. This is the primary deployment target -- the "brain" that runs 24/7.

Tested on Ubuntu 22.04 LTS and Ubuntu 24.04 LTS. Debian 12 (Bookworm) also works.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Install Runtime Dependencies](#install-runtime-dependencies)
3. [Clone and Build](#clone-and-build)
4. [Configuration](#configuration)
5. [Master Key and Secrets](#master-key-and-secrets)
6. [Database Initialization](#database-initialization)
7. [Systemd Service](#systemd-service)
8. [Automated Backups](#automated-backups)
9. [Firewall and Networking](#firewall-and-networking)
10. [Tailscale Mesh VPN](#tailscale-mesh-vpn)
11. [Telegram Bot Setup](#telegram-bot-setup)
12. [Monitoring](#monitoring)
13. [Upgrading](#upgrading)
14. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Minimum Version | Check Command |
|---|---|---|
| Ubuntu/Debian | 22.04 LTS+ | `lsb_release -a` |
| Bun | 1.0+ | `bun --version` |
| pnpm | 9+ | `pnpm --version` |
| Claude Code CLI | Latest | `claude --version` |
| git | 2.30+ | `git --version` |
| Node.js | 22+ (for pnpm) | `node --version` |

## Install Runtime Dependencies

### Bun

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

### Node.js and pnpm

pnpm requires Node.js. Install via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm
```

### Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

Authenticate with your Anthropic account:

```bash
claude login
```

This opens a browser for OAuth. If running on a headless server, use:

```bash
claude login --no-browser
```

Follow the instructions to authenticate via a URL on another device.

### Build Tools

```bash
sudo apt-get update
sudo apt-get install -y build-essential git curl
```

## Clone and Build

```bash
# Clone the repository
cd /opt
sudo git clone https://github.com/crack00r/eidolon.git
sudo chown -R $USER:$USER /opt/eidolon

# Install dependencies and build
cd /opt/eidolon
pnpm install
pnpm -r build

# Verify build
pnpm -r typecheck
pnpm -r test
```

## Configuration

### Create Configuration Directories

```bash
sudo mkdir -p /etc/eidolon
sudo mkdir -p /var/lib/eidolon
sudo mkdir -p /var/log/eidolon
```

### Create the Configuration File

```bash
sudo tee /etc/eidolon/eidolon.json << 'EOF'
{
  "identity": {
    "name": "Eidolon",
    "ownerName": "YourName"
  },
  "brain": {
    "accounts": [
      {
        "type": "oauth",
        "name": "primary",
        "credential": "oauth",
        "priority": 100
      }
    ],
    "model": {
      "default": "claude-sonnet-4-20250514",
      "complex": "claude-opus-4-20250514",
      "fast": "claude-haiku-3-20250414"
    },
    "session": {
      "maxTurns": 50,
      "compactAfter": 40,
      "timeoutMs": 300000
    }
  },
  "loop": {
    "energyBudget": {
      "maxTokensPerHour": 100000,
      "categories": {
        "user": 0.5,
        "tasks": 0.2,
        "learning": 0.2,
        "dreaming": 0.1
      }
    },
    "businessHours": {
      "start": "07:00",
      "end": "23:00",
      "timezone": "Europe/Berlin"
    }
  },
  "memory": {
    "extraction": {
      "strategy": "hybrid",
      "minConfidence": 0.7
    },
    "dreaming": {
      "enabled": true,
      "schedule": "02:00",
      "maxDurationMinutes": 30
    },
    "search": {
      "maxResults": 20,
      "rrfK": 60
    },
    "embedding": {
      "model": "Xenova/multilingual-e5-small",
      "dimensions": 384
    }
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": 8419,
    "auth": {
      "type": "token",
      "token": { "$secret": "GATEWAY_TOKEN" }
    }
  },
  "database": {
    "directory": "/var/lib/eidolon",
    "walMode": true,
    "backupPath": "/var/lib/eidolon/backups"
  },
  "logging": {
    "level": "info",
    "format": "json",
    "directory": "/var/log/eidolon",
    "maxSizeMb": 50,
    "maxFiles": 10
  },
  "daemon": {
    "pidFile": "/var/lib/eidolon/eidolon.pid",
    "gracefulShutdownMs": 10000
  },
  "security": {
    "audit": {
      "enabled": true,
      "retentionDays": 365
    }
  }
}
EOF
```

Adjust `identity.ownerName`, `loop.businessHours.timezone`, and other values to your situation. See the [Configuration Reference](../reference/CONFIGURATION.md) for all available options.

## Master Key and Secrets

### Generate the Master Key

The master key protects all encrypted secrets. Generate a cryptographically random key:

```bash
EIDOLON_MASTER_KEY=$(openssl rand -hex 32)
echo "$EIDOLON_MASTER_KEY"
```

Write down or save this key in a password manager. It cannot be recovered if lost.

### Store the Master Key

For the systemd service, create an environment file:

```bash
sudo tee /etc/eidolon/master-key.env << EOF
EIDOLON_MASTER_KEY=$EIDOLON_MASTER_KEY
EOF
sudo chmod 600 /etc/eidolon/master-key.env
sudo chown root:root /etc/eidolon/master-key.env
```

For interactive use, add to your shell profile:

```bash
echo "export EIDOLON_MASTER_KEY=$EIDOLON_MASTER_KEY" >> ~/.bashrc
source ~/.bashrc
```

### Set Secrets

Set the gateway authentication token (for desktop/iOS clients):

```bash
cd /opt/eidolon
export EIDOLON_CONFIG=/etc/eidolon/eidolon.json

bun packages/cli/src/index.ts secrets set GATEWAY_TOKEN
# Enter a strong random token when prompted
```

If you plan to use Telegram:

```bash
bun packages/cli/src/index.ts secrets set TELEGRAM_BOT_TOKEN
# Enter the bot token from @BotFather
```

If you use an API key account as a fallback:

```bash
bun packages/cli/src/index.ts secrets set ANTHROPIC_API_KEY
# Enter your Anthropic API key
```

If you plan to use a GPU worker:

```bash
bun packages/cli/src/index.ts secrets set GPU_WORKER_TOKEN
# Enter a shared secret for GPU worker authentication
```

List stored secrets to verify:

```bash
bun packages/cli/src/index.ts secrets list
```

## Database Initialization

Run the doctor command to initialize all three databases and verify the system:

```bash
export EIDOLON_CONFIG=/etc/eidolon/eidolon.json
export EIDOLON_DATA_DIR=/var/lib/eidolon

bun packages/cli/src/index.ts doctor
```

This creates:
- `/var/lib/eidolon/memory.db` -- memories, embeddings, knowledge graph
- `/var/lib/eidolon/operational.db` -- sessions, events, state, discoveries
- `/var/lib/eidolon/audit.db` -- audit log (append-only)

All databases use WAL (Write-Ahead Logging) mode for concurrent read safety.

## Systemd Service

### Create the Service User

```bash
sudo useradd --system --home-dir /var/lib/eidolon --shell /usr/sbin/nologin eidolon
sudo chown -R eidolon:eidolon /var/lib/eidolon
sudo chown -R eidolon:eidolon /var/log/eidolon
```

### Install the Service File

The service file is included in the repository at `deploy/eidolon.service`:

```bash
sudo cp /opt/eidolon/deploy/eidolon.service /etc/systemd/system/eidolon.service
```

Add the master key to the service. Edit the service file to include the environment file:

```bash
sudo systemctl edit eidolon
```

Add the following in the editor that opens:

```ini
[Service]
EnvironmentFile=/etc/eidolon/master-key.env
```

### Enable and Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable eidolon
sudo systemctl start eidolon
```

### Verify

```bash
sudo systemctl status eidolon
sudo journalctl -u eidolon -f
```

### Service Commands

```bash
sudo systemctl start eidolon      # Start the daemon
sudo systemctl stop eidolon       # Stop the daemon
sudo systemctl restart eidolon    # Restart the daemon
sudo systemctl status eidolon     # Check status
sudo journalctl -u eidolon -n 50  # View last 50 log lines
sudo journalctl -u eidolon -f     # Follow logs in real time
```

## Automated Backups

### Install Backup Timer

The repository includes a systemd timer for daily backups at 03:00:

```bash
sudo cp /opt/eidolon/deploy/eidolon-backup.service /etc/systemd/system/
sudo cp /opt/eidolon/deploy/eidolon-backup.timer /etc/systemd/system/
```

Add the master key environment to the backup service:

```bash
sudo systemctl edit eidolon-backup
```

Add:

```ini
[Service]
EnvironmentFile=/etc/eidolon/master-key.env
```

Enable the timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable eidolon-backup.timer
sudo systemctl start eidolon-backup.timer
```

Verify the timer is active:

```bash
sudo systemctl list-timers eidolon-backup.timer
```

### Manual Backup

```bash
bun packages/cli/src/index.ts backup run
```

Backups are stored in the path configured by `database.backupPath` (default: `/var/lib/eidolon/backups`).

## Firewall and Networking

### UFW (Uncomplicated Firewall)

Open port 8419 for the WebSocket gateway. Only allow Tailscale traffic:

```bash
# Allow SSH (essential -- do not lock yourself out)
sudo ufw allow ssh

# Allow Eidolon gateway from Tailscale subnet only
sudo ufw allow from 100.64.0.0/10 to any port 8419 proto tcp

# Enable the firewall
sudo ufw enable
sudo ufw status
```

If you are NOT using Tailscale and want to expose the gateway on your local network:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 8419 proto tcp
```

Never expose port 8419 to the public internet without TLS and strong authentication.

### iptables (Alternative)

```bash
# Allow from Tailscale network
sudo iptables -A INPUT -s 100.64.0.0/10 -p tcp --dport 8419 -j ACCEPT
# Drop all other traffic to 8419
sudo iptables -A INPUT -p tcp --dport 8419 -j DROP
```

## Tailscale Mesh VPN

Tailscale connects the Ubuntu server to your other devices (MacBook, Windows PC, iPhone) over an encrypted WireGuard mesh.

### Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

### Authenticate

```bash
sudo tailscale up
```

Follow the URL to authenticate with your Tailscale account.

### Verify Connectivity

```bash
tailscale status
tailscale ip -4    # Shows your Tailscale IP (100.x.x.x)
```

### Enable MagicDNS

In the Tailscale admin console (https://login.tailscale.com/admin/dns), enable MagicDNS. This allows other devices to reach your server by hostname (e.g., `ubuntu-server.tailnet.ts.net`).

### ACLs (Access Control)

In the Tailscale admin console, configure ACLs to restrict which devices can reach port 8419:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:client"],
      "dst": ["tag:server:8419"]
    }
  ],
  "tagOwners": {
    "tag:server": ["autogroup:admin"],
    "tag:client": ["autogroup:admin"]
  }
}
```

Tag your Ubuntu server as `tag:server` and client devices as `tag:client`.

## Telegram Bot Setup

### Create a Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the bot token (format: `123456789:ABCdefGHI...`).

### Store the Token

```bash
bun packages/cli/src/index.ts secrets set TELEGRAM_BOT_TOKEN
# Paste the token from BotFather
```

### Configure Telegram

Edit `/etc/eidolon/eidolon.json` and add the channels section:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" },
      "allowedUserIds": [YOUR_TELEGRAM_USER_ID]
    }
  }
}
```

To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot) on Telegram.

### Restart and Verify

```bash
sudo systemctl restart eidolon
```

Send a message to your bot in Telegram. It should respond.

## Monitoring

### Health Check

```bash
curl http://localhost:8419/health
```

Expected response:

```json
{
  "status": "healthy",
  "uptime": 86400,
  "checks": [
    { "name": "database", "status": "pass" },
    { "name": "claude", "status": "pass" }
  ]
}
```

### Daemon Status

```bash
bun packages/cli/src/index.ts daemon status
```

### Log Monitoring

```bash
# Follow daemon logs
sudo journalctl -u eidolon -f

# View structured log files
tail -f /var/log/eidolon/daemon.log | jq .
```

### Disk Space

Monitor database and log sizes:

```bash
du -sh /var/lib/eidolon/*.db
du -sh /var/log/eidolon/
du -sh /var/lib/eidolon/backups/
```

## Upgrading

### Pull and Rebuild

```bash
cd /opt/eidolon
git pull origin main
pnpm install
pnpm -r build
pnpm -r typecheck
```

### Restart the Service

```bash
sudo systemctl restart eidolon
sudo systemctl status eidolon
```

### Database Migrations

Migrations run automatically on startup. If you need to verify:

```bash
bun packages/cli/src/index.ts doctor
```

## Troubleshooting

### Daemon Fails to Start

Check the journal for error details:

```bash
sudo journalctl -u eidolon -n 100 --no-pager
```

Common causes:
- **Master key not set**: Ensure `/etc/eidolon/master-key.env` exists and the service override is configured.
- **Permission denied**: Ensure the `eidolon` user owns `/var/lib/eidolon` and `/var/log/eidolon`.
- **Config invalid**: Run `bun packages/cli/src/index.ts config validate` to check the config file.
- **Port in use**: Check if port 8419 is already bound: `sudo ss -tlnp | grep 8419`.

### Database Locked

If you see "database is locked" errors, ensure:
- Only one daemon process is running: `pgrep -f "eidolon daemon"`.
- WAL mode is enabled in the config (`database.walMode: true`).
- The database directory is on a local filesystem (not NFS or CIFS).

### Claude Code CLI Not Found

The systemd service runs as the `eidolon` user. Ensure Claude Code is installed globally or accessible in the service's `PATH`:

```bash
# Find where claude is installed
which claude

# If it is in a user-specific path, create a symlink
sudo ln -s /home/youruser/.npm-global/bin/claude /usr/local/bin/claude
```

### Tailscale Not Connected

```bash
sudo tailscale status
# If disconnected:
sudo tailscale up
```

### Out of Disk Space

Prune old backups and rotate logs:

```bash
# Remove backups older than 30 days
find /var/lib/eidolon/backups -name "*.db" -mtime +30 -delete

# Vacuum databases to reclaim space
bun packages/cli/src/index.ts doctor  # includes vacuum
```

### High Memory Usage

The embedding model (`multilingual-e5-small`) loads into memory on startup (~100MB). If the server is memory-constrained:
- Reduce `memory.embedding.batchSize` in the config.
- Consider disabling dreaming during peak hours.
- Monitor with `htop` or `systemctl status eidolon` (shows memory usage).
