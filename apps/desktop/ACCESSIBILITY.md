# Desktop App Accessibility Checklist -- WCAG 2.1 AA (P2-13)

> Last updated: 2026-03-06. Platform: Tauri 2.0 + Svelte.
> Reference: [WCAG 2.1 Guidelines](https://www.w3.org/TR/WCAG21/)

## Principle 1: Perceivable

### 1.1 Text Alternatives

- [ ] All images have `alt` text
- [ ] Decorative images use `alt=""` or `role="presentation"`
- [ ] Icon buttons have `aria-label` (e.g., send button, settings gear)
- [ ] Status indicators have text alternatives (not color-only)
- [ ] Charts/graphs have text summaries

### 1.2 Time-Based Media

- [ ] Audio responses have text transcription visible in chat
- [ ] No auto-playing audio without user action (except voice mode)
- [ ] Audio playback has pause/stop controls

### 1.3 Adaptable

- [ ] Content is structured with semantic HTML (`<nav>`, `<main>`, `<aside>`, `<article>`)
- [ ] Headings follow hierarchical order (h1 > h2 > h3)
- [ ] Form inputs have associated `<label>` elements
- [ ] Tables have `<th>` headers with `scope` attribute
- [ ] Reading order matches visual order
- [ ] Orientation is not locked (landscape and portrait work)

### 1.4 Distinguishable

- [ ] Text color contrast ratio >= 4.5:1 (normal text)
- [ ] Large text (18pt+) contrast ratio >= 3:1
- [ ] UI component contrast ratio >= 3:1 against background
- [ ] Focus indicator contrast ratio >= 3:1
- [ ] Color is not the only means of conveying information
  - [ ] Error states use icon + text, not just red color
  - [ ] Connection status uses icon + label, not just color
  - [ ] Memory confidence uses number + color, not just color
- [ ] Text can be resized to 200% without loss of content
- [ ] No horizontal scrolling at 320px viewport width (reflow)
- [ ] Text spacing can be adjusted without breaking layout:
  - Line height: 1.5x font size
  - Paragraph spacing: 2x font size
  - Letter spacing: 0.12x font size
  - Word spacing: 0.16x font size
- [ ] Hover/focus content (tooltips, dropdowns) can be dismissed (Escape) and does not obscure other content

## Principle 2: Operable

### 2.1 Keyboard Accessible

- [ ] All interactive elements reachable via Tab
- [ ] No keyboard traps
- [ ] Tab order follows visual flow
- [ ] Custom keyboard shortcuts do not conflict with browser/OS shortcuts
- [ ] Keyboard shortcuts can be disabled or remapped
- [ ] Focus is visible on all interactive elements
- [ ] Skip-to-main-content link available
- [ ] Modal dialogs trap focus correctly (Tab cycles within modal)
- [ ] Escape closes modals, dropdowns, and popups

### 2.2 Enough Time

- [ ] No time limits on user input
- [ ] Session timeout warnings give at least 20 seconds to extend
- [ ] Auto-updating content (streaming responses) can be paused

### 2.3 Seizures and Physical Reactions

- [ ] No content flashes more than 3 times per second
- [ ] No auto-playing animations that cannot be paused
- [ ] Loading spinners are subtle (no rapid flashing)

### 2.4 Navigable

- [ ] Page/view has a descriptive title (shown in window title bar)
- [ ] Focus order is logical and predictable
- [ ] Link text is descriptive (no "click here")
- [ ] Multiple ways to find content (search + navigation)
- [ ] Headings describe content
- [ ] Focus is visible at all times

### 2.5 Input Modalities

- [ ] All functionality works with pointer (mouse/touch)
- [ ] All functionality works with keyboard
- [ ] Drag-and-drop has keyboard alternative
- [ ] Touch targets are at least 24x24 CSS pixels

## Principle 3: Understandable

### 3.1 Readable

- [ ] Page language is declared (`lang="en"`)
- [ ] Abbreviations are expanded on first use or have `<abbr>` tags
- [ ] Error messages are in plain language

### 3.2 Predictable

- [ ] Focus changes do not trigger unexpected context changes
- [ ] Form submission requires explicit action (button click)
- [ ] Navigation is consistent across views
- [ ] UI components with same function have consistent labeling

### 3.3 Input Assistance

- [ ] Form errors are identified and described in text
- [ ] Required fields are clearly marked
- [ ] Input format hints are provided (e.g., "Enter server address as host:port")
- [ ] Error suggestions are provided where possible
- [ ] Destructive actions (delete memory, clear chat) have confirmation dialogs

## Principle 4: Robust

### 4.1 Compatible

- [ ] HTML validates (no duplicate IDs, proper nesting)
- [ ] ARIA roles, states, and properties are used correctly
- [ ] Custom components have proper ARIA roles:
  - [ ] Chat message list: `role="log"` with `aria-live="polite"`
  - [ ] Streaming text: `aria-live="polite"`
  - [ ] Connection status: `role="status"`
  - [ ] Error alerts: `role="alert"`
  - [ ] Navigation: `role="navigation"` with `aria-label`
  - [ ] Search results: `role="region"` with `aria-label`
- [ ] Status messages use `aria-live` regions

## Screen Reader Testing

### macOS (VoiceOver)

- [ ] Enable VoiceOver (Cmd+F5)
- [ ] Navigate all screens with VO+arrow keys
- [ ] All interactive elements are announced with role and label
- [ ] Chat messages are announced as they arrive
- [ ] Connection status changes are announced
- [ ] Landmark navigation works (VO+U for rotor)

### Windows (NVDA)

- [ ] Navigate all screens with arrow keys in browse mode
- [ ] Tab through interactive elements in focus mode
- [ ] All controls are properly announced
- [ ] Live regions announce updates

### Linux (Orca)

- [ ] Basic navigation works
- [ ] Interactive elements are accessible
- [ ] Landmark navigation functions

## Automated Testing Tools

Run these tools and fix all critical/serious issues:

- [ ] [axe DevTools](https://www.deque.com/axe/) browser extension: 0 critical issues
- [ ] [Lighthouse](https://developers.google.com/web/tools/lighthouse) accessibility audit: score >= 90
- [ ] Color contrast checker: all text passes AA
