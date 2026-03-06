# iOS App Verification Checklist (P2-11)

> Last updated: 2026-03-06. Platform: Swift/SwiftUI, iOS 17+.

## Prerequisites

- [ ] Eidolon Core daemon is running on the server
- [ ] Server is reachable from the iOS device (Tailscale, Cloudflare Tunnel, or local network)
- [ ] Gateway auth token is available
- [ ] App is installed via TestFlight or Xcode

## 1. WebSocket Connection

- [ ] App prompts for server address on first launch
- [ ] Connection methods work in priority order:
  - [ ] Bonjour auto-discovery (same local network)
  - [ ] Tailscale hostname resolution
  - [ ] Cloudflare Tunnel HTTPS endpoint
  - [ ] Manual IP:port entry
- [ ] Connection status is visible in the UI
- [ ] Reconnection happens automatically after network interruption
- [ ] App handles WiFi-to-cellular transition gracefully
- [ ] Auth token is sent and validated
- [ ] Invalid credentials show clear error

## 2. Chat Interface

- [ ] Text input field works with iOS keyboard
- [ ] Send button sends the message
- [ ] Keyboard dismisses when scrolling up
- [ ] Messages appear in chronological order
- [ ] Streaming responses render incrementally
- [ ] Markdown rendering works (bold, italic, code, links)
- [ ] Code blocks are horizontally scrollable
- [ ] Long messages are fully readable
- [ ] Chat scrolls to latest message
- [ ] Pull-to-refresh loads older history
- [ ] Haptic feedback on message send (optional setting)

## 3. Voice Mode

- [ ] Microphone permission is requested on first voice use
- [ ] Push-to-talk button is clearly visible
- [ ] Recording indicator shows during capture
- [ ] Audio is sent for STT transcription
- [ ] Transcription appears in chat
- [ ] TTS response plays through device speaker
- [ ] Audio plays through earpiece when held to ear (proximity sensor)
- [ ] Audio switches to speaker when face is away
- [ ] Works with AirPods and Bluetooth headphones
- [ ] Interruption handling: speaking stops playback
- [ ] Voice state indicator (idle/listening/processing/speaking)
- [ ] Works when GPU worker is offline (text-only fallback)

## 4. Push Notifications (APNs)

- [ ] Notification permission is requested on first launch
- [ ] Device token is registered with Core on connection
- [ ] Critical notifications arrive immediately (priority 10)
- [ ] Normal notifications arrive within 30 seconds (priority 5)
- [ ] Low-priority notifications arrive in batches (priority 1)
- [ ] Notification categories:
  - [ ] Learning discoveries show "Approve" and "Dismiss" actions
  - [ ] Reminders show "Snooze" and "Done" actions
  - [ ] Security alerts show "Review" action
- [ ] Tapping a notification opens the relevant screen
- [ ] Badge count updates correctly
- [ ] Notifications work when app is in background
- [ ] Notifications work when app is terminated
- [ ] DND schedule is respected (no notifications during configured quiet hours)

## 5. VoiceOver Accessibility

- [ ] All screens are navigable with VoiceOver enabled
- [ ] All interactive elements have accessibility labels
- [ ] Chat messages are read aloud in order
- [ ] Send button has clear accessibility label ("Send message")
- [ ] Voice mode button has descriptive label ("Start voice recording")
- [ ] Connection status is announced on change
- [ ] Custom actions are available where appropriate
- [ ] Dynamic Type (text scaling) works across all screens
- [ ] Color contrast meets WCAG 2.1 AA (4.5:1 for text, 3:1 for UI)

## 6. Background Behavior

- [ ] WebSocket disconnects gracefully when app enters background
- [ ] App reconnects when returning to foreground
- [ ] Push notification tap brings app to foreground and reconnects
- [ ] Background refresh fetches missed messages (APNs-triggered)
- [ ] No excessive battery drain in background
- [ ] Background audio continues if voice mode is active

## 7. Settings

- [ ] Server connection settings are editable
- [ ] Auth token can be updated
- [ ] Voice mode preferences (input device, auto-play responses)
- [ ] Notification preferences (enable/disable by category)
- [ ] DND schedule configuration
- [ ] Theme selection (light/dark/system)
- [ ] Text size follows iOS Dynamic Type setting

## 8. Error Handling

- [ ] Network unreachable: clear message with "Retry" button
- [ ] Server unreachable: shows connection troubleshooting tips
- [ ] Auth failure: prompts for new credentials
- [ ] STT failure: falls back to text input with notification
- [ ] TTS failure: falls back to text display with notification
- [ ] Crash recovery: app state is preserved after crash

## 9. Device Compatibility

- [ ] iPhone SE (smallest screen): all UI elements accessible
- [ ] iPhone 15 Pro Max (largest screen): layout uses available space
- [ ] iPad: split view works, layout adapts to larger screen
- [ ] Landscape orientation: layout adapts (at minimum, does not break)
- [ ] iOS 17: minimum supported version works
- [ ] iOS 18: latest version works

## 10. TestFlight Distribution

- [ ] App installs from TestFlight without errors
- [ ] TestFlight update notifications work
- [ ] Crash reports are collected via TestFlight
- [ ] Beta feedback can be submitted via TestFlight shake gesture
