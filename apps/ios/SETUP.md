# Eidolon iOS — Setup Guide

## Prerequisites

- Xcode 15+ (with iOS 17 SDK)
- macOS 14 Sonoma or later
- iPhone/iPad running iOS 17+ (or use Simulator)

## Creating the Xcode Project

No `.xcodeproj` is included — create it fresh in Xcode:

1. **Open Xcode** > File > New > Project
2. Select **iOS > App**
3. Configure:
   - Product Name: `Eidolon`
   - Team: None (Personal Team for local builds)
   - Organization Identifier: `com.eidolon`
   - Interface: **SwiftUI**
   - Language: **Swift**
   - Storage: None
   - Uncheck "Include Tests" (add later)
4. Save to a temporary location

### Replacing Project Files

5. **Delete** the auto-generated `ContentView.swift` and `EidolonApp.swift` from the project
6. **Drag** all files from `apps/ios/Eidolon/` into the Xcode project navigator
   - Make sure "Copy items if needed" is **unchecked** (reference in-place)
   - Target: Eidolon
7. Copy `Info.plist` into the project and set it in Build Settings > Info.plist File
8. Replace the auto-generated `Assets.xcassets` with the one from this directory

### Build Settings

9. Set **Deployment Target** to iOS 17.0
10. In **Signing & Capabilities**, use "Automatically manage signing" with your Personal Team
11. Add **Bonjour Services** capability if not already present:
    - `_eidolon._tcp`

### Important Notes

- **No Apple Developer Account required** for local device/simulator builds
- Push notifications are prepared but not activated (see `PushNotificationService.swift`)
- The app connects to Eidolon Core via WebSocket on port 8419
- Default connection: `ws://127.0.0.1:8419` (change in Settings tab)

## Running

- **Simulator**: Select any iPhone simulator, press Run
- **Device**: Connect iPhone via USB, trust the device, select it as target, press Run

## Architecture

```
Eidolon/
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
    PushNotificationService.swift  # APNs stub
  ViewModels/
    ChatViewModel.swift         # Chat state + send/receive
    MemoryViewModel.swift       # Memory search with debounce
    SettingsViewModel.swift     # Settings + Keychain token storage
  Views/
    ChatView.swift              # Chat interface with message bubbles
    MemoryView.swift            # Memory browser with search
    SettingsView.swift          # Connection settings form
```

## Gateway Protocol

The app uses JSON-RPC 2.0 over WebSocket, matching the desktop client:

- Port: 8419
- Auth: Token-based (first message after connect)
- Methods: `chat.send`, `memory.search`, `system.health`, etc.
- Push events: `chat.stream.chunk`, `chat.stream.end`

See `packages/protocol/src/types/gateway.ts` for the full protocol spec.
