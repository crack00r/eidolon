# Quick Start

Get Eidolon running in 5 minutes with a minimal CLI chat setup.

## Prerequisites

- **Bun** >= 1.0 ([install](https://bun.sh/docs/installation))
- **pnpm** >= 9 (`npm install -g pnpm`)
- **Claude Code CLI** ([install](https://docs.anthropic.com/en/docs/claude-code/overview))
- **git**

Verify the tools are installed:

```bash
bun --version       # should print >= 1.0
pnpm --version      # should print >= 9
claude --version    # should print a version string
git --version
```

## Step 1: Clone and Install

```bash
git clone https://github.com/crack00r/eidolon.git
cd eidolon
pnpm install
pnpm -r build
```

## Step 2: Authenticate Claude Code

If you have not already logged in to Claude Code, run:

```bash
claude login
```

Follow the browser-based OAuth flow. This authenticates your Anthropic Max/Pro subscription.

## Step 3: Create a Minimal Configuration

```bash
mkdir -p ~/.config/eidolon
cat > ~/.config/eidolon/eidolon.json << 'EOF'
{
  "identity": {
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
  }
}
EOF
```

Replace `YourName` with your actual name.

## Step 4: Set Up the Master Key

The master key encrypts all secrets at rest. Generate a strong random key:

```bash
export EIDOLON_MASTER_KEY=$(openssl rand -hex 32)
echo "EIDOLON_MASTER_KEY=$EIDOLON_MASTER_KEY" >> ~/.bashrc
```

For zsh users, append to `~/.zshrc` instead.

Save this key somewhere safe. If you lose it, encrypted secrets cannot be recovered.

## Step 5: Run the Doctor Check

```bash
cd /path/to/eidolon
bun packages/cli/src/index.ts doctor
```

The doctor command verifies:
- Bun version is adequate
- Claude Code CLI is installed and authenticated
- Configuration is valid
- Databases can be created and written to

Fix any reported issues before continuing.

## Step 6: Start Chatting

```bash
bun packages/cli/src/index.ts chat
```

Type a message and press Enter. Eidolon sends it to Claude Code under the hood and streams the response back to your terminal. The conversation is persistent across turns within the session.

Type `exit` or press `Ctrl+C` to quit.

## What Next?

- **Telegram bot**: See [Ubuntu Setup Guide](SETUP_UBUNTU.md) for full daemon + Telegram configuration.
- **Desktop app**: See [macOS Setup Guide](SETUP_MACOS.md) or [Windows Setup Guide](SETUP_WINDOWS.md) for the Tauri desktop client.
- **GPU voice**: See [Windows Setup Guide](SETUP_WINDOWS.md) for GPU worker setup with TTS/STT.
- **Docker**: See [Docker Setup Guide](SETUP_DOCKER.md) for containerized deployment.
- **Full configuration reference**: See [Configuration Reference](../reference/CONFIGURATION.md).

## Troubleshooting

**"Claude Code CLI not found"**

Ensure `claude` is in your `PATH`. Run `which claude` to verify. If installed via npm, it may be at `~/.npm-global/bin/claude`.

**"Config not found"**

Eidolon searches for configuration in this order:
1. Path specified with `--config` flag
2. `$EIDOLON_CONFIG` environment variable
3. `./eidolon.json` (current directory)
4. `~/.config/eidolon/eidolon.json`

**"Master key not set"**

Set the `EIDOLON_MASTER_KEY` environment variable. It must be a hex-encoded string of at least 32 characters (16 bytes).

**Build errors**

Run `pnpm -r typecheck` to see TypeScript errors. Ensure all packages are installed with `pnpm install`.
