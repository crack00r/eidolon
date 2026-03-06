# iOS VoiceOver Testing Checklist (P2-14)

> Last updated: 2026-03-06. Platform: Swift/SwiftUI, iOS 17+.
> VoiceOver is Apple's built-in screen reader for blind and low-vision users.

## Setup

1. Enable VoiceOver: Settings > Accessibility > VoiceOver > On
2. Or use Accessibility Shortcut: triple-click Side Button
3. VoiceOver gestures:
   - Swipe right: next element
   - Swipe left: previous element
   - Double-tap: activate element
   - Three-finger swipe up/down: scroll
   - Two-finger tap: pause/resume speech

## Screen-by-Screen Testing

### Launch / Connection Screen

- [ ] App name is announced on launch
- [ ] Server address input field has label: "Server address"
- [ ] Connect button has label: "Connect to server"
- [ ] Connection status is announced (e.g., "Connecting...", "Connected")
- [ ] Error messages are announced as alerts
- [ ] Bonjour auto-discovery results are listed with server names

### Chat Screen

- [ ] Screen title "Chat" is announced
- [ ] Message list is accessible as a scrollable region
- [ ] Each message announces: sender ("You" or "Eidolon"), then content
- [ ] New messages are announced automatically (`accessibilityAddTraits: .updatesFrequently`)
- [ ] Code blocks are read as "Code block: [content]"
- [ ] Links in messages are actionable
- [ ] Text input field has label: "Message"
- [ ] Text input has hint: "Type a message to Eidolon"
- [ ] Send button has label: "Send message"
- [ ] Send button is disabled (announced as "dimmed") when input is empty
- [ ] Streaming responses announce "Eidolon is typing" during generation
- [ ] Final response is announced when streaming completes

### Voice Mode

- [ ] Voice button has label: "Start voice recording"
- [ ] During recording, label changes to: "Stop recording"
- [ ] Voice state is announced:
  - "Listening" when recording
  - "Processing" when STT is running
  - "Speaking" when TTS is playing
  - "Ready" when idle
- [ ] Transcription result is announced
- [ ] TTS playback works with VoiceOver enabled (audio does not conflict)
- [ ] VoiceOver audio ducks during TTS playback (or TTS pauses VoiceOver)

### Memory Browser

- [ ] Screen title "Memory" is announced
- [ ] Search field has label: "Search memories"
- [ ] Each memory result announces: type, content summary, confidence
- [ ] Memory type filter has label: "Filter by type"
- [ ] Filter options are announced when selected
- [ ] Empty state announces: "No memories found"
- [ ] Swipe actions (if any) have accessibility labels

### Settings Screen

- [ ] Screen title "Settings" is announced
- [ ] All toggles announce their label and current state
- [ ] Server address field is editable and labeled
- [ ] Auth token field is marked as `.isSecureTextEntry`
- [ ] Section headers are announced as headings

### Notifications

- [ ] Notification banner is announced by VoiceOver
- [ ] Notification actions are accessible (approve, dismiss, snooze)
- [ ] Tapping notification navigates to correct screen
- [ ] Badge count is announced on app icon

## Accessibility Properties Checklist

### Labels and Hints

- [ ] Every button has `.accessibilityLabel`
- [ ] Text fields have `.accessibilityLabel` and `.accessibilityHint`
- [ ] Images have `.accessibilityLabel` or are hidden (`.accessibilityHidden(true)`)
- [ ] Decorative elements are hidden from VoiceOver

### Traits

- [ ] Buttons have `.button` trait
- [ ] Headers have `.header` trait
- [ ] Links have `.link` trait
- [ ] Images have `.image` trait
- [ ] Adjustable controls (sliders) have `.adjustable` trait
- [ ] Static text has `.staticText` trait
- [ ] Search fields have `.searchField` trait

### Dynamic Content

- [ ] Chat message list posts `.layoutChanged` notification on new messages
- [ ] Connection status posts `.announcement` notification on change
- [ ] Error alerts post `.screenChanged` notification
- [ ] Streaming text does not trigger excessive announcements (batched updates)

### Grouping

- [ ] Related elements are grouped with `.accessibilityElement(children: .combine)`
- [ ] Each chat message is a single accessibility element (sender + content combined)
- [ ] Navigation bar items are individually accessible
- [ ] Tab bar items are individually accessible

### Actions

- [ ] Custom swipe actions have descriptive labels
- [ ] Delete actions are labeled "Delete" (not "Remove" or custom text)
- [ ] Approve/Reject actions are clearly labeled
- [ ] Double-tap activates primary action

## Dynamic Type

- [ ] Text scales from xSmall to xxxLarge (Accessibility sizes)
- [ ] Layout does not break at largest text size
- [ ] No text truncation at largest size (or truncated text has "more" action)
- [ ] Images scale appropriately
- [ ] Minimum touch targets maintained at all text sizes

## Reduce Motion

- [ ] Animations respect `UIAccessibility.isReduceMotionEnabled`
- [ ] Parallax effects are disabled when Reduce Motion is on
- [ ] Transitions use cross-dissolve instead of slide when Reduce Motion is on

## Color and Contrast

- [ ] All text meets 4.5:1 contrast ratio (AA)
- [ ] Large text (18pt+) meets 3:1 contrast ratio
- [ ] UI controls meet 3:1 contrast ratio
- [ ] Information is not conveyed by color alone
- [ ] Dark mode maintains proper contrast ratios
- [ ] "Increase Contrast" accessibility setting is respected

## Testing Tools

- [ ] Xcode Accessibility Inspector: no issues on all screens
- [ ] Run with VoiceOver enabled: complete all user flows
- [ ] Run with Switch Control: verify all elements are reachable
- [ ] Run with Dynamic Type at xxxLarge: verify layout
- [ ] Run with Reduce Motion: verify no animations
- [ ] Run with Increase Contrast: verify readability
