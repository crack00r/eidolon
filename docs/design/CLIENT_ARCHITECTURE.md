# Client Architecture

> **Status: Implemented — v0.1.x. This document describes the design; see source code for implementation details.**
> Updated 2026-03-01 based on [expert review findings](../REVIEW_FINDINGS.md).

## Client Types

Eidolon supports four client types, all connecting to the Core daemon via WebSocket over Tailscale:

| Client | Platform | Technology | System Access | Voice |
|---|---|---|---|---|
| **Desktop App** | macOS, Windows, Linux | Tauri 2.0 (Rust + Svelte) | Deep (filesystem, shell, clipboard, processes) | Yes (via GPU worker) |
| **iOS App** | iPhone, iPad | Swift / SwiftUI | Limited (iOS sandbox) | Yes (via GPU worker) |
| **CLI** | Any (npm) | TypeScript (same as Core) | Shell-level | No |
| **Web Dashboard** | Browser | Svelte (embedded in Core) | Read-only (status, memory, learning) | No |

## Desktop App (Tauri 2.0)

### Why Tauri

| Aspect | Electron | Tauri |
|---|---|---|
| Binary size | ~150 MB | ~5 MB |
| RAM usage | ~100-300 MB | ~30-50 MB |
| Backend | Node.js | Rust |
| System access | Limited (via Node) | Deep (via Rust) |
| Security | Full Node.js in renderer | No Node.js in renderer |
| Auto-update | electron-updater | Built-in |
| Cross-platform | Yes | Yes (macOS, Windows, Linux) |

### Features

```
┌─────────────────────────────────────────────────┐
│              DESKTOP APP (Tauri)                  │
│                                                   │
│  ┌─────────────┐  ┌──────────────────────────┐  │
│  │ System Tray │  │ Main Window               │  │
│  │             │  │                           │  │
│  │ ● Status    │  │ ┌───────────────────────┐ │  │
│  │ ● Quick     │  │ │   Chat View           │ │  │
│  │   Actions   │  │ │                       │ │  │
│  │ ● Settings  │  │ │   Message history     │ │  │
│  │             │  │ │   Streaming responses  │ │  │
│  └─────────────┘  │ │   File attachments    │ │  │
│                    │ │   Code blocks         │ │  │
│                    │ └───────────────────────┘ │  │
│                    │                           │  │
│                    │ ┌───────────────────────┐ │  │
│                    │ │   Memory Browser      │ │  │
│                    │ │   Search + Browse      │ │  │
│                    │ │   Dream reports        │ │  │
│                    │ └───────────────────────┘ │  │
│                    │                           │  │
│                    │ ┌───────────────────────┐ │  │
│                    │ │   Learning Dashboard  │ │  │
│                    │ │   Discoveries          │ │  │
│                    │ │   Approvals            │ │  │
│                    │ │   Journal              │ │  │
│                    │ └───────────────────────┘ │  │
│                    │                           │  │
│                    │ ┌───────────────────────┐ │  │
│                    │ │   Settings            │ │  │
│                    │ │   Accounts, GPU, etc.  │ │  │
│                    │ └───────────────────────┘ │  │
│                    └──────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Deep System Access (Node Mode)

When a Desktop client connects, it registers as a **Node** with the Core, advertising its capabilities. The Core can then execute commands on the client's machine.

```typescript
// Client registers capabilities on connect
{
  type: 'node.register',
  capabilities: {
    platform: 'darwin',         // or 'win32', 'linux'
    systemRun: true,            // Can execute shell commands
    filesystem: true,           // Can read/write files
    clipboard: true,            // Can access clipboard
    notifications: true,        // Can show notifications
    screenshots: true,          // Can take screenshots
    processes: true,            // Can list/manage processes
    network: true,              // Can query network info
    camera: false,              // No camera on desktop (or true)
    microphone: true,           // For voice mode
  }
}
```

**Rust backend commands (Tauri plugins):**

| Command | macOS | Windows | Linux |
|---|---|---|---|
| Shell execute | `/bin/bash` | `powershell.exe` | `/bin/bash` |
| Read clipboard | `pbpaste` | `Get-Clipboard` | `xclip -o` |
| Write clipboard | `pbcopy` | `Set-Clipboard` | `xclip -i` |
| Notification | `NSUserNotification` | `toast` | `notify-send` |
| Screenshot | `screencapture` | `Add-Type -Assembly...` | `import -window root` |
| Open URL/file | `open` | `Start-Process` | `xdg-open` |
| Process list | `ps aux` | `Get-Process` | `ps aux` |
| System info | `system_profiler` | `Get-CimInstance` | `lshw` / `lscpu` |

### Auto-Update

Tauri has built-in auto-update using GitHub Releases:

```json
// tauri.conf.json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/crack00r/eidolon/releases/latest/download/latest.json"
      ],
      "dialog": true,
      "pubkey": "dW50cnVzdGVkIGNvbnRlbnQ="
    }
  }
}
```

## iOS App (Swift/SwiftUI)

### Features

| Feature | Description |
|---|---|
| Chat | Text messaging with markdown rendering |
| Voice | Push-to-talk with Qwen3-TTS responses |
| Push Notifications | Alerts from learning, reminders, system events |
| Shortcuts | Siri integration ("Hey Siri, ask Eidolon...") |
| Bonjour | Auto-discovery when on same local network |
| Background | Receive push notifications in background |
| Canvas | WebView surface for rich visual output |

### Connection Strategy

> **Review update (Mobile Developer):** Tailscale-only networking is a dealbreaker for real-world mobile use. Added Cloudflare Tunnel as alternative for non-VPN connectivity.

```
1. Try Bonjour (local network, zero-config)
   └── Found? Connect directly via local IP

2. Try Tailscale hostname
   └── Reachable? Connect via Tailscale

3. Try Cloudflare Tunnel
   └── Configured? Connect via public HTTPS endpoint
   └── Provides: HTTPS with Cloudflare's DDoS protection
   └── No VPN required on mobile device

4. Fallback: manual configuration
   └── User enters host:port
```

**Cloudflare Tunnel** (optional, recommended for mobile):
- Exposes Core's WebSocket endpoint via `https://eidolon.yourdomain.com`
- No port forwarding, no VPN required on mobile device
- Free tier available for personal use
- Configuration: `eidolon config set gateway.cloudflare.tunnelToken $TUNNEL_TOKEN`
- Authentication still required (gateway token in WebSocket handshake)

### Push Notifications (APNs)

> **Review update (Mobile Developer):** iOS kills background WebSocket connections. APNs is required for reliable push delivery. The server-side APNs implementation must be part of Core.

Since the iOS app can't maintain a persistent WebSocket in the background, push notifications via Apple Push Notification service (APNs) are used for alerts:

```
Core                          APNs                    iOS App
  │                             │                        │
  │── push notification ──────>│                        │
  │   (via APNs HTTP/2)        │── push ──────────────>│
  │                             │                        │
  │                             │        User opens app  │
  │                             │                        │
  │<── WebSocket connect ──────────────────────────────│
  │── catch-up events ────────────────────────────────>│
```

**Server-side APNs requirements (Phase 8 prerequisite):**
- APNs HTTP/2 client in Core (e.g., `apn` npm package or direct HTTP/2)
- APNs auth key stored in secret store
- Device token registration via WebSocket handshake
- Push payload: notification type, preview text, badge count
- Silent push for background refresh triggers

**Notification categories:**
| Category | APNs Priority | Example |
|---|---|---|
| `critical` | 10 (immediate) | Security alert, user-requested reminder |
| `normal` | 5 (power-aware) | Learning discovery, task completion |
| `low` | 1 (batched) | Dreaming report, daily digest |

**iOS timeline estimate:** 6 weeks (updated from original 2-week estimate). Includes: SwiftUI app, WebSocket, APNs integration, voice mode, VoiceOver accessibility, TestFlight setup.

## CLI

### Commands

```bash
# Daemon management
eidolon daemon start          # Start the daemon
eidolon daemon stop           # Stop the daemon
eidolon daemon status         # Show daemon status
eidolon daemon logs           # Tail daemon logs

# Setup
eidolon onboard              # Interactive setup wizard
eidolon doctor               # Health check

# Communication
eidolon chat                 # Interactive chat in terminal
eidolon send "message"       # Send a one-off message

# Memory
eidolon memory search "query"
eidolon memory list --type facts --since 7d
eidolon memory dream --now    # Trigger dreaming manually
eidolon memory export         # Export all memory as markdown

# Learning
eidolon learning status
eidolon learning discoveries --since 7d
eidolon learning approve <id>
eidolon learning dismiss <id>
eidolon learning discover --now
eidolon learning journal --date 2026-03-01

# Secrets
eidolon secrets set <key>
eidolon secrets list
eidolon secrets delete <key>

# Nodes & GPU
eidolon nodes list
eidolon gpu status

# Audit
eidolon audit --since 24h

# Configuration
eidolon config show
eidolon config set <key> <value>
eidolon config validate
```

### Installation

```bash
# Global install
npm install -g @eidolon-ai/cli

# Or with pnpm
pnpm add -g @eidolon-ai/cli

# Then onboard
eidolon onboard
```

## Web Dashboard

Lightweight web UI served directly by the Core daemon. Read-only status and monitoring.

```
http://localhost:18789/dashboard

┌─────────────────────────────────────────────┐
│  EIDOLON DASHBOARD                          │
│                                              │
│  Status: ● Running                          │
│  Uptime: 4d 12h 33m                         │
│  Phase: Idle (rest)                          │
│                                              │
│  ┌───────────┐  ┌────────────┐              │
│  │ Memory    │  │ Learning   │              │
│  │           │  │            │              │
│  │ 1,234     │  │ 47 items   │              │
│  │ memories  │  │ discovered │              │
│  │           │  │ this week  │              │
│  │ Last      │  │            │              │
│  │ dream:    │  │ 3 pending  │              │
│  │ 6h ago    │  │ approval   │              │
│  └───────────┘  └────────────┘              │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ Connected Nodes                       │   │
│  │                                       │   │
│  │ ● MacBook Pro (desktop, online)      │   │
│  │ ● Windows PC (desktop+gpu, online)   │   │
│  │ ○ iPhone (ios, offline)              │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ Recent Activity                       │   │
│  │                                       │   │
│  │ 14:32 Chat via Telegram              │   │
│  │ 14:15 Learning: 3 items discovered   │   │
│  │ 08:00 Dreaming complete (12 merged)  │   │
│  │ 07:45 GPU worker connected           │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## WebSocket Protocol

All clients use the same WebSocket protocol to communicate with the Core.

### Connection Handshake

```json
// Client -> Core
{
  "type": "connect",
  "auth": { "token": "..." },
  "device": {
    "id": "macbook-pro-001",
    "name": "MacBook Pro",
    "platform": "darwin",
    "role": "desktop",
    "capabilities": { ... }
  }
}

// Core -> Client
{
  "type": "connected",
  "sessionId": "...",
  "serverVersion": "0.1.0",
  "state": {
    "phase": "idle",
    "connectedNodes": [...],
    "memoryCount": 1234,
    "pendingApprovals": 3
  }
}
```

### RPC Calls

```json
// Client -> Core (request)
{
  "type": "rpc",
  "id": "req-001",
  "method": "chat.send",
  "params": {
    "text": "What's on my schedule today?",
    "channel": "desktop"
  }
}

// Core -> Client (streaming events)
{
  "type": "event",
  "event": "chat.stream",
  "data": {
    "requestId": "req-001",
    "delta": "Let me check your",
    "done": false
  }
}

// Core -> Client (final response)
{
  "type": "rpc_response",
  "id": "req-001",
  "result": {
    "text": "Let me check your calendar...",
    "tokens": { "input": 450, "output": 120 }
  }
}
```

### Push Events

```json
// Core -> Client (unsolicited)
{
  "type": "event",
  "event": "learning.discovery",
  "data": {
    "id": "disc-001",
    "title": "sqlite-vec 0.2.0 released",
    "source": "reddit",
    "score": 85,
    "classification": "ACTIONABLE",
    "requiresApproval": true
  }
}

{
  "type": "event",
  "event": "approval.request",
  "data": {
    "id": "appr-001",
    "action": "implement_discovery",
    "description": "Update sqlite-vec to 0.2.0",
    "timeout": "2026-03-02T14:00:00Z"
  }
}
```

## GitHub Release Workflows

### Desktop Builds

```yaml
# .github/workflows/release-desktop.yml
name: Release Desktop
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: macos-latest
            target: aarch64-apple-darwin
            artifact: Eidolon.dmg
          - platform: macos-latest
            target: x86_64-apple-darwin
            artifact: Eidolon-intel.dmg
          - platform: windows-latest
            target: x86_64-pc-windows-msvc
            artifact: Eidolon.msi
          - platform: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            artifact: eidolon.AppImage

    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
      - name: Build Tauri
        uses: tauri-apps/tauri-action@v0
        with:
          projectPath: apps/desktop
      - name: Upload artifact
        uses: actions/upload-artifact@v4
```

### CLI Publish

```yaml
# .github/workflows/release-cli.yml
name: Release CLI
on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          registry-url: 'https://registry.npmjs.org'
      - run: pnpm install
      - run: pnpm build
      - run: pnpm publish --filter @eidolon-ai/cli
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```
