# Eidolon iOS -- Setup Guide

## Prerequisites

- Xcode 16+ (with iOS 17 SDK)
- macOS 14 Sonoma or later
- iPhone/iPad running iOS 17+ (or use Simulator)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) for generating the Xcode project

## Generating the Xcode Project

The repository does not include a `.xcodeproj` file. It is generated from
`project.yml` using XcodeGen, which provides a deterministic, merge-friendly
project definition.

### Install XcodeGen

```bash
# Homebrew (recommended)
brew install xcodegen

# Or via Mint
mint install yonaskolb/xcodegen
```

### Generate the project

```bash
cd apps/ios
xcodegen generate
```

This creates `Eidolon.xcodeproj` from `project.yml`. The generated project file
is gitignored -- regenerate it whenever the source file list changes.

### Open in Xcode

```bash
open Eidolon.xcodeproj
```

### Build Settings

1. Set **Deployment Target** to iOS 17.0 (already configured in `project.yml`)
2. In **Signing & Capabilities**, use "Automatically manage signing" with your Personal Team
3. Bonjour Services capability (`_eidolon._tcp`) is included via Info.plist

### Important Notes

- **No Apple Developer Account required** for local device/simulator builds
- Push notifications are prepared but not activated (see `PushNotificationService.swift`)
- The app connects to Eidolon Core via WebSocket on port 8419
- Default connection: `ws://127.0.0.1:8419` (change in Settings tab)

## Running

- **Simulator**: Select any iPhone simulator, press Run
- **Device**: Connect iPhone via USB, trust the device, select it as target, press Run

## CI Builds

The CI workflow generates the Xcode project automatically:

```bash
brew install xcodegen
cd apps/ios
xcodegen generate
xcodebuild build -project Eidolon.xcodeproj -scheme Eidolon -destination 'platform=iOS Simulator,name=iPhone 16'
```

For signed archive builds (requires Apple Developer Account), see
`deploy/build-ios.yml.reference`.

## Architecture

```
apps/ios/
  project.yml                     # XcodeGen project spec (generates .xcodeproj)
  SETUP.md                        # This file
  Eidolon/
    EidolonApp.swift              # @main entry point
    ContentView.swift             # Tab navigation root
    Info.plist                    # App configuration
    Eidolon.entitlements          # App entitlements
    Assets.xcassets/              # Colors and app icon
    Models/
      GatewayTypes.swift          # JSON-RPC 2.0 types + AnyCodable
      Message.swift               # Chat message model
      Memory.swift                # Memory item model
    Services/
      WebSocketService.swift      # WebSocket client (URLSessionWebSocketTask)
      NetworkManager.swift        # Bonjour/Tailscale/Cloudflare discovery
      DiscoveryService.swift      # UDP beacon listener
      PushNotificationService.swift  # APNs stub
      Logger.swift                # os.Logger facade with ring buffer
      AudioService.swift          # AVAudioEngine microphone capture
      VoiceManager.swift          # Voice state machine + WebSocket integration
    ViewModels/
      ChatViewModel.swift         # Chat state + send/receive
      MemoryViewModel.swift       # Memory search with debounce
      SettingsViewModel.swift     # Settings + Keychain token storage
    Views/
      ChatView.swift              # Chat interface with message bubbles + voice toggle
      MemoryView.swift            # Memory browser with search
      SettingsView.swift          # Connection settings form
      VoiceOverlay.swift          # Full-screen voice conversation overlay
```

## Voice Mode

The app includes a voice mode for hands-free conversation:

### How it works

1. Tap the microphone icon in the Chat toolbar to activate voice mode
2. A full-screen overlay appears with push-to-talk or always-listening modes
3. Audio is captured at 16 kHz mono PCM via AVAudioEngine
4. Audio is sent to the Eidolon Core server for STT (speech-to-text)
5. The server processes the text through Claude and returns a response
6. If TTS is available (GPU worker online), audio is played back

### Voice state machine

```
idle -> listening -> processing -> speaking -> idle
                                      |
                          (barge-in) -> interrupted -> idle
```

### Requirements

- Microphone permission (prompted on first use)
- Active WebSocket connection to Eidolon Core
- iOS `.voiceChat` audio session mode provides built-in echo cancellation
- Background audio entitlement allows voice to continue when app is backgrounded

## Gateway Protocol

The app uses JSON-RPC 2.0 over WebSocket, matching the desktop client:

- Port: 8419
- Auth: Token-based (first message after connect)
- Methods: `chat.send`, `memory.search`, `system.health`, `voice.start`, `voice.stop`, etc.
- Push events: `chat.stream.chunk`, `chat.stream.end`, `voice.audio`, `voice.transcript`

See `packages/protocol/src/types/gateway.ts` for the full protocol spec.
