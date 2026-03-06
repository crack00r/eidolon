# Installation Guide

Step-by-step instructions for installing and configuring Eidolon on your system.

## Prerequisites

Before installing Eidolon, ensure the following are available on your machine:

### 1. Bun (v1.1.0 or later)

Bun is the JavaScript runtime that powers Eidolon.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
```

On Windows, use WSL2 or install Bun natively via PowerShell:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. Claude Code CLI

Eidolon uses Claude Code as its reasoning engine. Install it globally:

```bash
npm install -g @anthropic-ai/claude-code
```

Authenticate with your Anthropic account:

```bash
claude login
```

You need either an Anthropic Max/Pro subscription (OAuth) or an API key.

### 3. pnpm (for development only)

If you are building from source rather than installing via npm:

```bash
npm install -g pnpm
```

## Installation

### Option A: Install via npm (recommended)

```bash
npm install -g @eidolon-ai/cli
```

Or with pnpm:

```bash
pnpm add -g @eidolon-ai/cli
```

This installs the `eidolon` command globally.

### Option B: Build from source

```bash
git clone https://github.com/crack00r/eidolon.git
cd eidolon
pnpm install
pnpm -r build
```

Then link the CLI globally:

```bash
cd packages/cli
pnpm link --global
```

## First-Time Setup

Run the onboarding wizard:

```bash
eidolon onboard
```

The wizard walks you through:

1. **Claude authentication** -- configure your Anthropic account(s)
2. **Secret store** -- set your master encryption key
3. **Configuration** -- create `eidolon.json` with your preferences
4. **Database initialization** -- create the three SQLite databases (memory.db, operational.db, audit.db)
5. **Health check** -- verify everything is working

## Manual Configuration

If you prefer to configure manually instead of using the wizard, create `eidolon.json` in one of these locations (searched in order):

1. Path specified by `EIDOLON_CONFIG` environment variable
2. `./eidolon.json` (current directory)
3. `~/.config/eidolon/eidolon.json` (Linux/macOS)

### Minimal configuration

```json
{
  "identity": {
    "ownerName": "Your Name"
  },
  "brain": {
    "accounts": [
      {
        "type": "oauth",
        "name": "primary",
        "credential": "oauth"
      }
    ]
  },
  "gateway": {
    "auth": { "type": "none" }
  }
}
```

### Setting secrets

Never put API keys or tokens directly in `eidolon.json`. Use the encrypted secret store:

```bash
# Store a secret
eidolon secrets set TELEGRAM_BOT_TOKEN

# Reference it in config
# "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" }

# List stored secrets
eidolon secrets list
```

For the full configuration reference, see [CONFIGURATION.md](reference/CONFIGURATION.md).

## Platform-Specific Notes

### macOS

- Data directory: `~/Library/Application Support/eidolon/`
- Config directory: `~/Library/Preferences/eidolon/`
- Homebrew Bun path: `/opt/homebrew/bin/bun` (Apple Silicon) or `/usr/local/bin/bun` (Intel)
- For automatic startup, install the launchd agent:

```bash
cp deploy/com.eidolon.daemon.plist ~/Library/LaunchAgents/
# Edit the plist to replace REPLACE_WITH_USERNAME with your username
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### Ubuntu / Debian Linux

- Data directory: `~/.local/share/eidolon/`
- Config directory: `~/.config/eidolon/`
- For automatic startup via systemd:

```bash
sudo cp deploy/eidolon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable eidolon
sudo systemctl start eidolon
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed systemd setup instructions.

### Windows (via WSL2)

Eidolon runs best under WSL2 on Windows. Install Bun inside your WSL2 distribution:

```bash
curl -fsSL https://bun.sh/install | bash
```

The Windows PC is typically used as a GPU worker for TTS/STT rather than running the core daemon. See [GPU_AND_VOICE.md](design/GPU_AND_VOICE.md) for GPU worker setup.

## Verifying Installation

Run the doctor command to check that everything is configured correctly:

```bash
eidolon doctor
```

The doctor checks:

- Bun version (>= 1.1.0)
- Claude Code CLI installed and authenticated
- Configuration file valid
- Databases writable
- Disk space sufficient
- Secret store accessible

A healthy system reports all checks as PASS:

```
Eidolon Doctor
  [PASS] Bun version 1.2.0
  [PASS] Claude Code CLI installed (v1.0.0)
  [PASS] Configuration valid
  [PASS] Databases writable (memory.db, operational.db, audit.db)
  [PASS] Disk space sufficient (42 GB free)
  [PASS] Secret store accessible

All checks passed.
```

## Starting the Daemon

Once setup is complete:

```bash
# Start in foreground (for testing)
eidolon daemon start --foreground

# Start as background daemon
eidolon daemon start

# Check status
eidolon daemon status

# Stop the daemon
eidolon daemon stop
```

## Troubleshooting

### "Claude Code CLI not found"

Ensure `claude` is in your PATH:

```bash
which claude
```

If not found, reinstall: `npm install -g @anthropic-ai/claude-code`

### "Configuration validation failed"

Run validation to see specific errors:

```bash
eidolon config validate
```

Common issues:
- Missing `identity.ownerName` (required)
- Missing `brain.accounts` (at least one account required)
- Missing `gateway.auth.token` when auth type is "token" (set to "none" or provide a token)

### "Database not writable"

Check permissions on the data directory:

```bash
ls -la ~/.local/share/eidolon/    # Linux
ls -la ~/Library/Application\ Support/eidolon/  # macOS
```

Ensure the directory exists and is writable by your user.

### "Master key not set"

Set the master encryption key for the secret store:

```bash
export EIDOLON_MASTER_KEY="your-secure-master-key"
```

For persistent configuration, add this to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) or use your platform's keychain integration.

### Port 8419 already in use

The gateway defaults to port 8419. If another process is using it:

```bash
# Change the port in eidolon.json
# "gateway": { "port": 8420 }

# Or via environment variable
export EIDOLON_GATEWAY__PORT=8420
```

### High memory usage on startup

The embedding model (`multilingual-e5-small`, ~23MB) loads on startup. This is normal and only happens once. If memory is constrained, disable memory search in the configuration.

## Next Steps

- Configure [Telegram](design/CHANNELS.md) for mobile access
- Set up [GPU workers](design/GPU_AND_VOICE.md) for voice
- Install the [Desktop app](design/CLIENT_ARCHITECTURE.md) for macOS/Windows/Linux
- Review [Security](design/SECURITY.md) settings
