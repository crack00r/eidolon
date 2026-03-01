# Accessibility

> **Status: Design — not yet implemented.**
> Created 2026-03-01 based on [expert review findings](../REVIEW_FINDINGS.md) (M-2).

## Compliance Target

**WCAG 2.1 Level AA** for all client UIs (desktop, iOS, web dashboard).

## Voice-First: Accidentally Great for Accessibility

Eidolon's voice-first design is inherently accessible. A user who cannot see a screen can interact entirely through voice via Telegram voice messages, the desktop voice mode, or the iOS app's push-to-talk.

This is a genuine competitive advantage — most coding assistants are screen-dependent.

## Desktop Client (Tauri)

### Screen Reader Support
- All UI elements must have ARIA labels
- Chat messages: role, timestamp, and content announced
- Memory browser: results announced with type and relevance score
- System tray: status changes announced via live region

### Keyboard Navigation
- All features accessible without a mouse
- Tab order follows visual layout
- Focus indicators visible (minimum 2px solid outline, 3:1 contrast)
- Keyboard shortcuts documented and customizable:
  - `Ctrl+Space` — push-to-talk (configurable)
  - `Ctrl+Enter` — send message
  - `Ctrl+K` — command palette
  - `Escape` — cancel/close

### Visual Accessibility
- Color contrast: minimum 4.5:1 for text, 3:1 for large text (WCAG AA)
- No information conveyed by color alone (icons + text for status)
- Font scaling: respects system font size preference
- Reduced motion: respects `prefers-reduced-motion` media query
- Dark mode: follows system preference

### Voice Mode Accessibility
- Voice state changes announced via screen reader
- Visual waveform supplemented with text status ("Listening...", "Speaking...")
- Haptic feedback option for state transitions (on supported hardware)

## iOS App

### VoiceOver Support
- All UI elements have accessibility labels and hints
- Custom actions for chat messages (copy, reply, memory context)
- Dynamic type: all text scales with system font size
- Voice mode: VoiceOver announces state transitions

### iOS Accessibility Features
- Supports: VoiceOver, Switch Control, Voice Control, Dynamic Type
- Minimum touch target: 44x44 points
- Haptic feedback for state changes (UIFeedbackGenerator)

## CLI

### Terminal Accessibility
- All output is plain text (screen readers work natively)
- No essential information in color alone (always accompanied by text)
- `--no-color` flag for color-stripped output
- Machine-readable output: `--format json` for all commands
- Progress indicators: text-based (not just spinner animations)

## Web Dashboard

### Standards
- Semantic HTML (not divs with click handlers)
- ARIA landmarks for navigation
- Skip-to-content link
- Form labels associated with inputs
- Error messages associated with form fields via `aria-describedby`

## Testing

- Automated: axe-core checks in CI for web/desktop
- Manual: VoiceOver walkthrough for iOS before each release
- Keyboard-only navigation test for desktop before each release

## Implementation Priority

Accessibility is integrated into each phase, not a separate task:

| Phase | Accessibility Work |
|---|---|
| Phase 0 | CLI `--no-color`, `--format json` flags |
| Phase 7 | Desktop: keyboard nav, screen reader, contrast, font scaling |
| Phase 8 | iOS: VoiceOver, Dynamic Type, touch targets |
| Phase 9 | Automated a11y testing in CI |
