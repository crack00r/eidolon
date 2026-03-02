# iOS Client Setup

Complete guide for building and running the Eidolon iOS client on iPhone and iPad.

The iOS app is a native SwiftUI application that connects to the Eidolon brain server via WebSocket.

## Prerequisites

| Requirement | Version |
|---|---|
| macOS | 14 Sonoma or later |
| Xcode | 15+ (with iOS 17 SDK) |
| iOS Device | iPhone/iPad running iOS 17+ (or Simulator) |
| Apple Developer Account | Optional (free Personal Team works for local builds) |

> **Note:** No Apple Developer Account ($99/year) is required for building and running on your own device. A free Personal Team is sufficient. A paid account is only needed for push notifications and TestFlight distribution.

## Project Setup

The iOS app source is in `apps/ios/`. No `.xcodeproj` file is committed to the repository — you create it from Xcode.

### 1. Create the Xcode Project

1. Open **Xcode** > File > New > Project
2. Select **iOS > App**
3. Configure:
   - **Product Name**: `Eidolon`
   - **Team**: Your Personal Team (or Apple Developer Team)
   - **Organization Identifier**: `com.eidolon`
   - **Interface**: SwiftUI
   - **Language**: Swift
   - **Storage**: None
   - Uncheck "Include Tests" (add later)
4. Save to a temporary location

### 2. Replace Project Files

5. **Delete** the auto-generated `ContentView.swift` and `EidolonApp.swift` from the project navigator
6. **Drag** all files from `apps/ios/Eidolon/` into the Xcode project navigator
   - **Uncheck** "Copy items if needed" (reference files in-place)
   - Target: Eidolon
7. Copy `Info.plist` into the project root and set it in Build Settings > **Info.plist File**
8. Replace the auto-generated `Assets.xcassets` with `apps/ios/Eidolon/Assets.xcassets`

### 3. Build Settings

9. Set **Deployment Target** to iOS 17.0
10. In **Signing & Capabilities**, use "Automatically manage signing" with your team
11. Add **Bonjour Services** capability:
    - Service type: `_eidolon._tcp`

## Project Structure

```
apps/ios/Eidolon/
  EidolonApp.swift              # @main entry point
  ContentView.swift             # Tab navigation root
  Info.plist                    # App configuration
  Assets.xcassets/              # Colors and app icon

  Models/
    GatewayTypes.swift          # JSON-RPC 2.0 types + AnyCodable
    Message.swift               # Chat message model
    Memory.swift                # Memory item model

  Services/
    WebSocketService.swift      # WebSocket client (URLSessionWebSocketTask)
    NetworkManager.swift        # Bonjour/Tailscale/Cloudflare discovery
    PushNotificationService.swift  # APNs stub (activates with Dev account)

  ViewModels/
    ChatViewModel.swift         # Chat state + send/receive logic
    MemoryViewModel.swift       # Memory search with debounce
    SettingsViewModel.swift     # Settings + Keychain token storage

  Views/
    ChatView.swift              # Chat interface with message bubbles
    MemoryView.swift            # Memory browser with search
    SettingsView.swift          # Connection settings form
```

## Configuring the Server Connection

### Default Connection

The app defaults to `ws://127.0.0.1:8419`. Change this in the **Settings** tab after launching.

### Using Tailscale

If both your iPhone and the server are on the same Tailscale network:

1. Install [Tailscale for iOS](https://apps.apple.com/app/tailscale/id1470499037)
2. Log in with the same Tailscale account as the server
3. In the Eidolon app Settings, enter:
   - **Server**: `ubuntu-server.tailnet.ts.net` (or the Tailscale IP)
   - **Port**: `8419`
   - **Token**: Your gateway auth token

### Using Cloudflare Tunnel (Alternative)

If you cannot run Tailscale on iOS (e.g., corporate restrictions), use a Cloudflare Tunnel:

1. Set up a Cloudflare Tunnel on the server (see [Network Guide](NETWORK.md))
2. In the Eidolon app Settings, enter:
   - **Server**: `eidolon.yourdomain.com`
   - **Port**: `443`
   - **Use TLS**: Enabled

### Bonjour Discovery

If the iPhone is on the same local network as the server, the app will attempt automatic discovery via Bonjour (mDNS). The server advertises `_eidolon._tcp`. If found, the server address is pre-filled.

## Running the App

### Simulator

1. Select an iPhone simulator from the Xcode toolbar (e.g., iPhone 15 Pro)
2. Press **Run** (Cmd+R)
3. The app launches in the simulator
4. Go to the **Settings** tab to configure the server connection

> **Note:** The simulator cannot use Tailscale. For testing, either run the brain server locally on your Mac or use a Cloudflare Tunnel.

### Physical Device

1. Connect your iPhone via USB
2. Trust the computer on the device if prompted
3. Select the device as the build target in Xcode
4. Press **Run** (Cmd+R)
5. On first install, go to Settings > General > VPN & Device Management on the iPhone to trust the developer certificate

### Wireless Debugging

After the first USB connection:
1. In Xcode, go to Window > Devices and Simulators
2. Select your device
3. Check "Connect via network"
4. You can now disconnect USB and deploy wirelessly

## App Features

| Feature | Description |
|---|---|
| Chat | Text messaging with Eidolon, streamed responses |
| Voice | Talk mode with microphone input (STT via GPU worker) |
| Memory | Search and browse the memory database |
| Settings | Server connection, appearance, notifications |
| Push Notifications | Prepared but requires Apple Developer account to activate |

## Gateway Protocol

The app communicates using JSON-RPC 2.0 over WebSocket:

| Method | Description |
|---|---|
| `auth.login` | Authenticate with gateway token |
| `chat.send` | Send a chat message |
| `chat.history` | Retrieve conversation history |
| `memory.search` | Search the memory database |
| `system.health` | Get server health status |

Push events from the server:
- `chat.stream.chunk` — Streaming response text
- `chat.stream.end` — Response complete
- `system.notification` — Alerts and notifications

See `packages/protocol/src/types/gateway.ts` for the full protocol specification.

## TestFlight Distribution

When an Apple Developer account ($99/year) is available:

### 1. Configure Signing

- Select your Apple Developer Team in Xcode signing settings
- Enable the Push Notifications capability
- Create an App ID in the Apple Developer portal with push notification entitlement

### 2. Archive and Upload

1. In Xcode, select **Any iOS Device** as the build target
2. Product > Archive
3. In the Organizer, click **Distribute App**
4. Select **TestFlight & App Store**
5. Follow the upload wizard

### 3. TestFlight Setup

1. Go to [App Store Connect](https://appstoreconnect.apple.com/)
2. Add the uploaded build to a TestFlight group
3. Invite testers via email
4. Testers install the TestFlight app and accept the invitation

### Automated Builds

Release builds are automatically triggered by `release-please` on the `main` branch. The CI pipeline archives the iOS app and uploads it as a release asset. With an Apple Developer account configured in CI, builds can be automatically uploaded to TestFlight.

## Troubleshooting

### Build fails: "No such module"

- Ensure all source files from `apps/ios/Eidolon/` are added to the Xcode project
- Check that files are added to the correct target (Eidolon)
- Clean build folder: Product > Clean Build Folder (Cmd+Shift+K)

### Cannot connect to server

- Verify the server address and port in the Settings tab
- Check that Tailscale is connected on both the iPhone and the server
- Try the direct Tailscale IP instead of the hostname
- Check the auth token matches the server's `GATEWAY_TOKEN`

### App crashes on launch

- Check the Xcode console for crash logs
- Verify iOS 17+ deployment target
- Clean and rebuild: Cmd+Shift+K, then Cmd+R

### Voice input not working

- Grant microphone permission when prompted (or in Settings > Privacy > Microphone)
- Voice requires a running [GPU Worker](GPU_WORKER.md) for speech-to-text
- Verify the GPU worker is reachable from the brain server

### Device not showing in Xcode

- Ensure the device is unlocked
- Try a different USB cable
- Restart Xcode
- Check that you have trusted the computer on the device

### "Untrusted Developer" on device

Go to Settings > General > VPN & Device Management > Select your developer certificate > Trust.

## Next Steps

- [Server Setup](SERVER.md) — set up the brain server
- [Network Guide](NETWORK.md) — Tailscale and Cloudflare Tunnel options
- [Desktop Client](DESKTOP.md) — desktop alternative
- [Web Dashboard](WEB.md) — browser-based alternative
