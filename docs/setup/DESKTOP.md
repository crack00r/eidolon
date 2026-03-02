# Desktop Client Setup — Tauri

Complete guide for installing and running the Eidolon desktop client on macOS, Windows, and Linux.

The desktop client is a Tauri 2.0 application (Svelte 5 frontend + Rust backend) that connects to the Eidolon brain server via WebSocket.

## Using Pre-Built Installers

Download the latest release from [GitHub Releases](https://github.com/crack00r/eidolon/releases). Each release includes platform-specific installers.

### macOS (.dmg)

1. Download `Eidolon_x.y.z_universal.dmg` from the latest release
2. Open the `.dmg` file
3. Drag **Eidolon** to the Applications folder

**Bypassing Gatekeeper (unsigned app):**

Since the app is not signed with an Apple Developer certificate, macOS will block it on first launch:

```
"Eidolon" can't be opened because Apple cannot check it for malicious software.
```

To open it:
- **Method 1**: Right-click (or Control-click) the app in Applications > Select **Open** > Click **Open** in the dialog
- **Method 2**: Go to System Settings > Privacy & Security > Scroll down to the blocked app notice > Click **Open Anyway**
- **Method 3** (Terminal):
  ```bash
  xattr -cr /Applications/Eidolon.app
  ```

After the first launch, macOS remembers your choice and won't block it again.

### Windows (.exe / .msi)

Two installer formats are available:

- **`Eidolon_x.y.z_x64-setup.exe`** — NSIS installer (recommended)
  - Double-click to run
  - Follow the installation wizard
  - Installs to `C:\Program Files\Eidolon\`
  - Creates Start Menu shortcuts

- **`Eidolon_x.y.z_x64_en-US.msi`** — MSI installer
  - Double-click to run, or install silently:
    ```powershell
    msiexec /i Eidolon_x.y.z_x64_en-US.msi /quiet
    ```
  - Suitable for enterprise/group policy deployment

**Windows SmartScreen:** If SmartScreen blocks the installer, click "More info" > "Run anyway".

### Linux (.AppImage / .deb)

**AppImage (all distributions):**

```bash
# Download the AppImage
chmod +x Eidolon_x.y.z_amd64.AppImage

# Run
./Eidolon_x.y.z_amd64.AppImage
```

Optional: integrate with your desktop environment using [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher).

**Debian/Ubuntu (.deb):**

```bash
sudo dpkg -i eidolon_x.y.z_amd64.deb

# If there are missing dependencies:
sudo apt-get install -f

# Launch
eidolon
```

## First Launch

On first launch, the app will show a connection setup screen.

### 1. Enter Server Address

Enter the Tailscale hostname or IP of your brain server:

```
Server: ubuntu-server.tailnet.ts.net
Port:   8419
```

Or use a direct Tailscale IP:

```
Server: 100.x.x.y
Port:   8419
```

### 2. Enter Auth Token

Enter the gateway auth token. This is the same value stored in the brain server's secret store as `GATEWAY_TOKEN`:

```
Token: your-gateway-auth-token
```

### 3. Connect

Click **Connect**. The status indicator in the system tray should turn green. You should see:
- Connection status: Connected
- Server version displayed
- Chat interface becomes active

### 4. System Tray

The app runs in the system tray by default:
- **Green dot**: Connected to server
- **Yellow dot**: Reconnecting
- **Red dot**: Disconnected
- **Right-click menu**: Show window, settings, disconnect, quit

## Features

| Feature | Description |
|---|---|
| Chat | Send messages, view conversation history |
| Voice Mode | Talk using microphone (requires GPU worker for TTS/STT) |
| Memory Browser | Search and browse the memory database |
| Learning Dashboard | View discoveries, approve implementations |
| System Access | Execute local commands (deep access node) |
| Settings | Configure connection, appearance, notifications |

## Building from Source

For developers who want to build the desktop client locally.

### Prerequisites

| Requirement | Version |
|---|---|
| [Rust](https://rustup.rs/) | Stable (latest) |
| [Node.js](https://nodejs.org/) | 22+ |
| [pnpm](https://pnpm.io/) | 9+ |

**Platform-specific dependencies:**

**macOS:**
```bash
xcode-select --install
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**Windows:**
- Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload
- Install [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (usually pre-installed on Windows 10/11)

### Install Tauri CLI

```bash
cargo install tauri-cli
```

### Build

```bash
cd apps/desktop

# Install frontend dependencies
pnpm install

# Development mode (hot-reload)
cargo tauri dev

# Production build
cargo tauri build
```

The production build output is in `apps/desktop/src-tauri/target/release/bundle/`:
- macOS: `.dmg` and `.app`
- Windows: `.exe` (NSIS) and `.msi`
- Linux: `.AppImage` and `.deb`

### Development Mode

```bash
cd apps/desktop
cargo tauri dev
```

This starts the Svelte dev server with hot-reload and opens the Tauri window. Changes to Svelte files update instantly; changes to Rust code trigger a recompile.

## Connecting to the Brain Server

The desktop client communicates with the brain server using JSON-RPC 2.0 over WebSocket.

**Connection flow:**
1. Client opens WebSocket to `ws://server:8419` (or `wss://` with TLS)
2. Client sends authentication message with the gateway token
3. Server validates token (constant-time comparison)
4. On success, client receives a welcome event with server capabilities
5. Client can now send RPC calls (`chat.send`, `memory.search`, etc.)

**Connection settings** are stored locally:
- macOS: `~/Library/Application Support/com.eidolon.app/`
- Windows: `%APPDATA%\com.eidolon.app\`
- Linux: `~/.config/com.eidolon.app/`

## Troubleshooting

### Cannot connect to server

- Verify the brain server is running: `eidolon daemon status` on the server
- Check Tailscale connectivity: `ping ubuntu-server.tailnet.ts.net`
- Verify the port matches: default is `8419`
- Check the auth token matches the server's `GATEWAY_TOKEN` secret

### App crashes on startup (Linux)

Missing system libraries. Install the required dependencies:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev
```

### Blank screen after launch

- Check the developer console: View menu > Developer Tools (or Ctrl+Shift+I)
- Ensure WebView2 is installed (Windows)
- Try clearing app data and reconnecting

### Audio/voice not working

- Voice requires a configured [GPU Worker](GPU_WORKER.md) for TTS/STT
- Check microphone permissions in system settings
- Verify GPU worker is reachable from the brain server: `eidolon doctor`

### macOS: app won't open after update

Reset the Gatekeeper decision:

```bash
xattr -cr /Applications/Eidolon.app
```

### High CPU usage

- Check the reconnection interval — rapid reconnection attempts indicate a connection issue
- Verify the server is healthy: `eidolon doctor` on the server

## Next Steps

- [Server Setup](SERVER.md) — set up the brain server
- [Network Guide](NETWORK.md) — Tailscale and connectivity
- [Web Dashboard](WEB.md) — browser-based alternative
- [iOS Client](IOS.md) — mobile client
