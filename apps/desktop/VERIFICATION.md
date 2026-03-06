# Desktop App Verification Checklist (P2-10)

> Last updated: 2026-03-06. Platform: Tauri 2.0 + Svelte.

## Prerequisites

- [ ] Eidolon Core daemon is running (`eidolon daemon status` shows "running")
- [ ] Gateway is accessible at the configured host:port (default `127.0.0.1:8419`)
- [ ] Gateway auth token is configured (or auth type is "none" for local testing)
- [ ] Desktop app is built (`pnpm --filter @eidolon/desktop tauri build`) or running in dev mode

## 1. WebSocket Connection

- [ ] App connects to Core gateway on startup
- [ ] Connection status indicator shows "Connected" (green)
- [ ] If Core is down, status shows "Disconnected" (red) with retry indicator
- [ ] Reconnection happens automatically when Core comes back online
- [ ] Auth token is sent during WebSocket handshake
- [ ] Invalid auth token shows clear error message (not silent failure)
- [ ] Connection survives Core restart (auto-reconnect)

## 2. Chat Interface

- [ ] Text input field accepts messages
- [ ] Pressing Enter sends the message
- [ ] Shift+Enter creates a new line (does not send)
- [ ] Sent messages appear in the message list immediately
- [ ] "Thinking..." indicator shows while Claude processes
- [ ] Streaming response appears token-by-token
- [ ] Markdown rendering works (headings, lists, code blocks, links)
- [ ] Code blocks have syntax highlighting
- [ ] Code blocks have a "Copy" button
- [ ] Long messages are scrollable
- [ ] Chat scrolls to bottom on new messages
- [ ] Previous message history loads on connection
- [ ] File/image attachments can be added to messages
- [ ] Error responses display clearly (not silent failure)

## 3. Memory Browser

- [ ] Search field accepts queries
- [ ] Search results appear within 2 seconds
- [ ] Results show memory content, type, confidence, and date
- [ ] Clicking a result shows full memory details
- [ ] Memory type filters work (fact, preference, decision, episode, skill)
- [ ] Memory layer filters work (working, short_term, long_term)
- [ ] Individual memories can be edited
- [ ] Individual memories can be deleted (with confirmation dialog)
- [ ] Dream reports are accessible and readable
- [ ] Knowledge graph entities are browsable

## 4. Learning Dashboard

- [ ] Discoveries list loads and displays
- [ ] Each discovery shows: title, source, relevance score, status
- [ ] "Approve" button works for pending implementations
- [ ] "Reject" button works for pending implementations
- [ ] Approval/rejection updates the status immediately
- [ ] Learning journal entries are readable
- [ ] Discovery count and pending count are accurate

## 5. System Tray

- [ ] Tray icon appears in the system tray on startup
- [ ] Icon color reflects daemon status:
  - Green: connected and healthy
  - Yellow: connected but degraded
  - Red: disconnected
- [ ] Left-click opens/focuses the main window
- [ ] Right-click shows context menu with:
  - [ ] "Open Eidolon" (opens main window)
  - [ ] "Status: Connected/Disconnected"
  - [ ] "Quit" (exits the app)
- [ ] App continues running in tray when window is closed (not fully quit)
- [ ] Closing the window minimizes to tray (configurable in settings)

## 6. Voice Mode

- [ ] Microphone permission is requested on first use
- [ ] Push-to-talk hotkey works (default: Ctrl+Space)
- [ ] Voice activity indicator shows when recording
- [ ] Audio is sent to Core for STT processing
- [ ] Transcription result appears in chat
- [ ] TTS response plays through speakers
- [ ] Barge-in (speaking during playback) stops playback
- [ ] Voice state transitions are visible (idle/listening/processing/speaking)
- [ ] Works when GPU worker is offline (falls back to text-only with notification)

## 7. Auto-Update

- [ ] Update check runs on startup (after 5-second delay)
- [ ] Update notification dialog appears when update is available
- [ ] "Update Now" downloads and installs the update
- [ ] "Later" dismisses the dialog (re-checks on next startup)
- [ ] Update progress is shown during download
- [ ] App restarts after successful update
- [ ] Update works on all platforms:
  - [ ] macOS (ARM)
  - [ ] macOS (Intel)
  - [ ] Windows
  - [ ] Linux (AppImage)

## 8. Keyboard Navigation (WCAG 2.1 AA)

- [ ] All interactive elements are reachable via Tab key
- [ ] Tab order follows visual layout (left-to-right, top-to-bottom)
- [ ] Focus indicator is visible on all focused elements
- [ ] Enter/Space activates buttons and links
- [ ] Escape closes modals and dropdowns
- [ ] Keyboard shortcuts are documented in Settings
- [ ] No keyboard traps (can always Tab out of any component)
- [ ] Skip-to-content link is available (for screen readers)

## 9. Settings

- [ ] Settings page loads
- [ ] Gateway connection settings are editable
- [ ] Theme selection works (light/dark/system)
- [ ] Notification preferences are configurable
- [ ] Voice mode settings are configurable (hotkey, input device, output device)
- [ ] Changes are persisted across app restarts

## 10. Error States and Offline Mode

- [ ] Offline banner appears when WebSocket disconnects
- [ ] Chat input is disabled when offline (with explanation)
- [ ] Previously loaded data (memories, discoveries) remains visible offline
- [ ] Error messages are user-friendly (not raw error codes)
- [ ] Network errors show retry countdown

## Platform-Specific Checks

### macOS
- [ ] App appears in Dock and can be Cmd+Tab'd to
- [ ] Native macOS menu bar shows Eidolon menu
- [ ] Cmd+Q quits the app (or minimizes to tray based on setting)
- [ ] Drag-and-drop file attachment works

### Windows
- [ ] App appears in taskbar
- [ ] System tray icon works in Windows 11 overflow area
- [ ] Windows notifications appear for push events
- [ ] High DPI scaling is correct

### Linux
- [ ] AppImage launches without additional dependencies
- [ ] System tray works (if supported by DE)
- [ ] Notifications work via libnotify
