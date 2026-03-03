# macOS Setup Guide

This guide covers two macOS use cases:

1. **Client only** -- Running the Tauri desktop app that connects to an Eidolon server elsewhere.
2. **Server + Client** -- Running the full Eidolon daemon locally on your Mac (useful for development or single-machine setups).

Tested on macOS 14 (Sonoma) and macOS 15 (Sequoia), both Intel and Apple Silicon.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Install Dependencies via Homebrew](#install-dependencies-via-homebrew)
3. [Desktop App (Client Only)](#desktop-app-client-only)
4. [Full Server Setup](#full-server-setup)
5. [Running as a Background Service (launchd)](#running-as-a-background-service-launchd)
6. [Tailscale for macOS](#tailscale-for-macos)
7. [Voice Mode](#voice-mode)
8. [Development Setup](#development-setup)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Minimum Version | Check Command |
|---|---|---|
| macOS | 14.0 (Sonoma)+ | `sw_vers` |
| Homebrew | Latest | `brew --version` |
| Xcode CLI Tools | Latest | `xcode-select -p` |

Install Xcode Command Line Tools if not present:

```bash
xcode-select --install
```

Install Homebrew if not present:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

## Install Dependencies via Homebrew

```bash
# Runtime
brew install oven-sh/bun/bun
brew install node@22
brew install pnpm

# Verify
bun --version       # >= 1.0
node --version      # >= 22
pnpm --version      # >= 9
```

### Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude --version
claude login
```

## Desktop App (Client Only)

If your Eidolon daemon runs on a separate server (Ubuntu, Docker, etc.), you only need the desktop client.

### Install from GitHub Releases

1. Go to the [Eidolon Releases page](https://github.com/crack00r/eidolon/releases).
2. Download the macOS DMG:
   - `Eidolon-arm64.dmg` for Apple Silicon (M1/M2/M3/M4)
   - `Eidolon-x64.dmg` for Intel Macs
3. Open the DMG and drag Eidolon to your Applications folder.
4. On first launch, macOS may block the app. Go to **System Settings > Privacy & Security** and click **Open Anyway**.

### Connect to Your Server

1. Launch Eidolon from Applications.
2. In Settings, enter your server's connection details:
   - **Host**: Your server's Tailscale IP or hostname (e.g., `100.64.0.1` or `ubuntu-server.tailnet.ts.net`)
   - **Port**: `8419` (default)
   - **Token**: The gateway token you set on the server
3. The app connects via WebSocket and you can start chatting.

### Build from Source (Alternative)

If you want to build the desktop app yourself:

```bash
# Prerequisites for Tauri
brew install rust

cd /path/to/eidolon
pnpm install

# Build the desktop app
cd apps/desktop
pnpm tauri build
```

The built app will be in `apps/desktop/src-tauri/target/release/bundle/`.

## Full Server Setup

Running Eidolon as a server on macOS. This is useful for development or if your Mac is your primary machine.

### Clone and Build

```bash
git clone https://github.com/crack00r/eidolon.git ~/Projects/eidolon
cd ~/Projects/eidolon
pnpm install
pnpm -r build
```

### Create Configuration

```bash
mkdir -p ~/.config/eidolon
```

Create `~/.config/eidolon/eidolon.json`:

```json
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
    ]
  },
  "gateway": {
    "host": "0.0.0.0",
    "port": 8419,
    "auth": {
      "type": "token",
      "token": { "$secret": "GATEWAY_TOKEN" }
    }
  },
  "logging": {
    "level": "info",
    "format": "pretty"
  }
}
```

### Set Up the Master Key

```bash
export EIDOLON_MASTER_KEY=$(openssl rand -hex 32)
echo "export EIDOLON_MASTER_KEY=$EIDOLON_MASTER_KEY" >> ~/.zshrc
source ~/.zshrc
```

Save this key in a password manager.

### Store Secrets

```bash
cd ~/Projects/eidolon
bun packages/cli/src/index.ts secrets set GATEWAY_TOKEN
# Enter a strong token for client authentication
```

### Initialize and Verify

```bash
bun packages/cli/src/index.ts doctor
```

### Run the Daemon (Foreground)

For testing or development:

```bash
bun packages/cli/src/index.ts daemon start --foreground
```

Press `Ctrl+C` to stop.

## Running as a Background Service (launchd)

macOS uses `launchd` instead of systemd. The repository includes a plist file at `deploy/com.eidolon.daemon.plist`.

### Install the Launch Agent

```bash
# Copy the plist to the LaunchAgents directory
cp ~/Projects/eidolon/deploy/com.eidolon.daemon.plist ~/Library/LaunchAgents/

# Edit the plist to set your master key
# Open with your preferred editor:
open -a TextEdit ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

Add your master key to the `EnvironmentVariables` section in the plist:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>EIDOLON_MASTER_KEY</key>
    <string>your_hex_master_key_here</string>
</dict>
```

If you cloned the repository to a non-standard location, also update the `ProgramArguments` paths accordingly.

### Load the Service

```bash
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### Verify

```bash
launchctl list | grep eidolon
# Should show: PID  0  com.eidolon.daemon

# Check logs
tail -f /tmp/eidolon-stdout.log
tail -f /tmp/eidolon-stderr.log
```

### Service Commands

```bash
# Start
launchctl start com.eidolon.daemon

# Stop
launchctl stop com.eidolon.daemon

# Unload (disable)
launchctl unload ~/Library/LaunchAgents/com.eidolon.daemon.plist

# Reload (after editing plist)
launchctl unload ~/Library/LaunchAgents/com.eidolon.daemon.plist
launchctl load ~/Library/LaunchAgents/com.eidolon.daemon.plist
```

### Log File Location

The plist directs stdout and stderr to:
- `/tmp/eidolon-stdout.log`
- `/tmp/eidolon-stderr.log`

For production use, change these paths in the plist to a permanent location:

```xml
<key>StandardOutPath</key>
<string>/Users/youruser/.local/state/eidolon/logs/daemon-stdout.log</string>

<key>StandardErrorPath</key>
<string>/Users/youruser/.local/state/eidolon/logs/daemon-stderr.log</string>
```

## Tailscale for macOS

Tailscale connects your Mac to the Eidolon server and other devices.

### Install

```bash
brew install --cask tailscale
```

Or download from the [Mac App Store](https://apps.apple.com/app/tailscale/id1475387142).

### Configure

1. Open Tailscale from the menu bar.
2. Sign in with the same account used on your server.
3. Verify connectivity:

```bash
tailscale status
ping ubuntu-server.tailnet.ts.net
```

### Verify Eidolon Connectivity

```bash
curl http://ubuntu-server.tailnet.ts.net:8419/health
```

You should see a JSON health response from the Eidolon daemon.

## Voice Mode

Voice mode requires a GPU worker for high-quality TTS/STT. The Mac itself can serve as a fallback using CPU-based TTS.

### CPU Fallback (No GPU Required)

Eidolon falls back through this chain when a GPU worker is unavailable:
1. **Qwen3-TTS on GPU** (requires a GPU worker elsewhere)
2. **Kitten TTS on CPU** (runs on the Mac)
3. **macOS system TTS** (uses the `say` command)
4. **Text-only mode** (no voice)

### macOS System TTS

macOS includes built-in TTS via the `say` command. No setup required. To test:

```bash
say "Hello, I am Eidolon."
```

To change the voice:

```bash
say -v '?'          # List available voices
say -v Samantha "Hello"
```

### Connecting to a Remote GPU Worker

If you have a GPU worker running on another machine (e.g., Windows PC with RTX 5080), add it to your config:

```json
{
  "gpu": {
    "workers": [
      {
        "name": "windows-gpu",
        "host": "windows-pc.tailnet.ts.net",
        "port": 8420,
        "token": { "$secret": "GPU_WORKER_TOKEN" },
        "capabilities": ["tts", "stt", "realtime"]
      }
    ]
  }
}
```

## Development Setup

If you are developing Eidolon on macOS:

### Clone and Install

```bash
git clone https://github.com/crack00r/eidolon.git ~/Projects/eidolon
cd ~/Projects/eidolon
pnpm install
```

### Common Development Commands

```bash
pnpm -r build       # Build all packages
pnpm -r typecheck   # Type checking
pnpm -r test        # Run all tests
pnpm -r lint        # Lint all packages
pnpm -r lint:fix    # Lint with auto-fix
```

### Run Tests for a Specific Package

```bash
cd packages/core
bun test

# Or from root:
pnpm --filter @eidolon/core test
```

### IDE Setup

For VS Code / Cursor:
1. Open the `eidolon` folder.
2. Install recommended extensions: ESLint, Biome, TypeScript.
3. The workspace `tsconfig.json` references configure path aliases automatically.

## Troubleshooting

### "App is damaged and can't be opened"

macOS quarantines downloaded apps. Remove the quarantine attribute:

```bash
xattr -cr /Applications/Eidolon.app
```

### launchd Service Not Starting

Check the system log:

```bash
log show --predicate 'subsystem == "com.apple.xpc.launchd"' --last 5m | grep eidolon
```

Common causes:
- **Wrong path in plist**: Ensure `ProgramArguments` points to the correct `bun` binary. On Apple Silicon, Homebrew installs to `/opt/homebrew/bin/bun`.
- **Missing master key**: Ensure `EIDOLON_MASTER_KEY` is set in the plist's `EnvironmentVariables`.
- **Permission denied**: The plist runs as your user. Ensure the clone directory is readable.

### Bun Not Found in launchd

launchd has a minimal `PATH`. Ensure the plist includes Homebrew's bin directory:

```xml
<key>PATH</key>
<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
```

On Intel Macs, Homebrew installs to `/usr/local/bin`. On Apple Silicon, it is `/opt/homebrew/bin`.

### "Permission denied" When Accessing Microphone

For voice mode, macOS requires microphone permission. Go to **System Settings > Privacy & Security > Microphone** and enable access for the Eidolon desktop app.

### Port 8419 Already in Use

```bash
lsof -i :8419
# Kill the conflicting process or change the port in config
```

### Tailscale Connection Issues

```bash
tailscale status
tailscale ping ubuntu-server  # Test connectivity
tailscale netcheck            # Network diagnostics
```

If the connection is unstable, try:
- Disabling "Use Tailscale subnet routes" if you do not need it.
- Checking your firewall (System Settings > Network > Firewall) -- Tailscale should be allowed.
