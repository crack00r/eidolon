# Eidolon Desktop App Audit -- Rounds 6 & 7

**Date**: 2026-03-08
**Scope**: Round 6 covers code quality and consistency (imports, error messages, TypeScript strictness, Rust quality). Round 7 covers UI/UX edge cases (loading states, empty states, error states, navigation, responsive design).
**Prior rounds**: Rounds 1-5 found ~70 issues. All critical and high issues fixed. 4M + 4L remain from Round 5.

---

## Compilation Status

| Check | Result |
|-------|--------|
| TypeScript (`pnpm -r typecheck`) | 0 errors, 0 warnings across 6 packages |
| Rust (`cargo check`) | 0 errors, 1 warning (deprecated `Shell::open`, tracked since R4-M4) |
| Test suite (`pnpm -r test`) | 3112 pass (2941 core + 171 cli), 6 skip, **0 fail** across 206 files |

---

## Round 6: Code Quality & Consistency

### 6.1 Import Consistency

**Result: CLEAN -- no issues found.**

All Svelte pages and stores import only what they use. Verified:

- `App.svelte`: All 12 imports are used (components, stores, logger).
- `+layout.svelte`: `onMount`, `getVersion`, `connectionState` -- all used.
- `chat/+page.svelte`: `clientLog` used in error handlers, all store imports used.
- `dashboard/+page.svelte`: `onMount`, `onDestroy`, all dashboard store exports -- all used. `connectionState` and `isConnected` used in the template.
- `memory/+page.svelte`: `onDestroy` used for debounce timer cleanup. All memory store imports used.
- `learning/+page.svelte`: `onMount` used for initial fetch. `clientLog` used in error handlers. All learning store imports used.
- `settings/+page.svelte`: `onMount`, `invoke`, `check`, `relaunch`, all settings/connection imports -- all used.
- All stores (`chat.ts`, `connection.ts`, `dashboard.ts`, `memory.ts`, `learning.ts`, `settings.ts`): no unused imports.
- `api.ts`: `getRecentErrors` and `clearErrorBuffer` from logger are used in `flushErrorBuffer()`.
- `discovery.ts`: `clientLog` is used. `BeaconPayload`, `SignedBeaconPayload` used in type guards.

No missing imports that could cause runtime errors detected.

### 6.2 Error Messages Quality

**Result: GOOD overall, 2 minor suggestions.**

The app generally provides user-friendly error messages. `sanitizeErrorForDisplay()` in `utils.ts` strips file paths and stack traces from displayed errors. Specific observations:

- **R6-L1: `chat.ts` line 39 -- error message could be more actionable.**
  `"Message too long (max ${MAX_MESSAGE_LENGTH} characters)"` -- Good, includes the limit.

- **R6-L2: `connection.ts` line 34 -- generic error message.**
  `errorStore.set("Connection failed")` -- does not explain why or suggest a next step.
  Suggestion: Include the underlying state or hint, e.g. "Connection failed. Check that the server is running and reachable."

- **R6-L3: `api.ts` line 161 -- generic error message for WebSocket creation.**
  The `catch` block on `new WebSocket(url)` silently falls to error state with no message surfaced to the user. The `onerror` handler also provides no detail. This is a WebSocket limitation (browsers don't expose error details), so no fix is possible.

- Error messages in Rust commands are generally clear:
  - `"Claude CLI not found. Install it from https://claude.ai/download"` -- actionable.
  - `"Authorization timed out after 3 minutes"` -- clear.
  - `"Blocked URL scheme. Only http:// and https:// are allowed."` -- clear.
  - `"Daemon already running"` -- clear.
  - `"No Claude token found. Run setup first."` -- actionable.
  - `"No server section in config"` -- developer-oriented but appears only in error paths from config parsing, acceptable.

### 6.3 TypeScript Strictness

**Result: CLEAN -- no `as any` casts found.**

- Zero uses of `as any` across all desktop source files.
- Two `as unknown as T` casts in `discovery.ts` (lines 80, 89) are used correctly after `isValidBeacon()` type guard validation. These are the standard TypeScript pattern for narrowing through an intermediate `unknown` type after runtime validation. Not hiding bugs.
- `dashboard.ts` line 95: `const energy = raw.energy as { current?: number; max?: number } | undefined` -- This is a raw-to-typed assertion on data from an RPC response. Each field is then individually checked with `typeof` guards (lines 124-125). Safe pattern.
- `dashboard.ts` lines 102-104: `rawState as CognitiveState` -- guarded by a `Set.has()` check on the line above. Safe.
- `chat.ts` line 44: Immediate-unsubscribe pattern `streamingStore.subscribe((v) => ...)()` -- idiomatic Svelte for synchronous store reads. Correct.

No optional chaining that hides null access bugs:
- `msg.streaming ? ...` checks are used correctly (streaming is an optional boolean on ChatMessage).
- `$selectedMemory?.id` in memory page -- safe because the entire block is guarded by `{#if $selectedMemory}`.

### 6.4 Rust Code Quality

**Result: 2 medium issues, 1 low issue.**

**R6-M1: Four `unwrap()` calls on `serde_json` operations that cannot technically fail but violate defensive coding. (commands.rs lines 814, 841, 1023, 1062)**

```rust
let skeleton_obj = skeleton.as_object().unwrap();  // lines 814, 1023
serde_json::to_string_pretty(&config).unwrap()      // lines 841, 1062
```

The `build_skeleton_sections()` function always returns a `json!({...})` object, and `serde_json::to_string_pretty` on a valid `serde_json::Value` cannot fail. So these `unwrap()` calls will never panic in practice. However, if someone later modifies `build_skeleton_sections()` to return a non-object, the panic would crash the entire Tauri process with no user-facing error.

Recommendation: Replace with `unwrap_or_else(|_| ...)` or `expect("...")` for the serialization calls, and use `.and_then(|o| ...)` with a descriptive error for the `.as_object()` calls.

**R6-M2: `stop_daemon` poll loop uses `Mutex::lock` on every iteration (commands.rs lines 311-313).**

The lock is correctly scoped to a block so the guard is dropped before the `await`, and this was already fixed in Round 5 (M-3). However, polling a mutex 50 times/second for up to 5 seconds creates unnecessary contention if other Tauri commands also try to read daemon state concurrently. This is a minor performance concern, not a correctness issue.

**R6-L4: `start_daemon` uses `unwrap_or_else(|e| e.into_inner())` for mutex poisoning recovery (line 188).**

This is actually a deliberate design choice -- if the mutex is poisoned (which means a thread panicked while holding it), `into_inner()` recovers the inner data. This is acceptable for this use case since the inner data is just `Option<CommandChild>`, but it's worth noting that poisoned mutex recovery can mask underlying panics. All 5 uses of this pattern in `commands.rs` are consistent. Low priority.

---

## Round 7: UI/UX Edge Cases

### 7.1 Loading States

**Result: ADEQUATE -- 1 minor issue.**

| Page | Loading State | Behavior |
|------|--------------|----------|
| App startup | "Eidolon" logo shown during `appState === "loading"` | GOOD -- centered logo with error display area |
| Dashboard | `dashboardLoading` store tracks initial fetch | PARTIAL -- `store.update(s => ({...s, loading: true}))` is set in `startDashboard()`, but the template does not render a loading indicator. The dashboard shows default zeros/idle until the first poll completes (~0-5 seconds). |
| Chat | Streaming placeholder "Thinking..." with blinking cursor | GOOD -- user sees immediate feedback, cursor animates until response arrives |
| Memory | `$isSearching` shown as "Searching..." indicator | GOOD |
| Learning | `$isLoadingLearning` controls refresh button text "Loading..." | GOOD |
| Settings | Version shows "..." then resolves | GOOD |
| Onboarding | Server discovery shows "Searching for servers..." | GOOD |

**R7-L1: Dashboard has no loading indicator for initial data fetch.**

The `dashboardLoading` derived store exists (line 272 of dashboard.ts) but is never imported or used in `+page.svelte`. When the dashboard first loads, energy bar shows 0/100, tasks show 0, memories show 0, uptime shows "0s" -- all default placeholder values. After the first `system.status` poll succeeds (up to 5 seconds), real values appear. This creates a brief period where the dashboard looks like an empty/idle system even if the brain is active.

Recommendation: Import `dashboardLoading` and show a subtle loading shimmer or "Loading..." text on the stats cards until the first fetch completes.

### 7.2 Empty States

**Result: GOOD -- all pages handle empty states.**

| Page | Empty State | Message |
|------|------------|---------|
| Chat | `$messages.length === 0` | "No messages yet" + "Send a message to start a conversation with Eidolon." |
| Dashboard Activity Feed | `$recentEvents.length === 0` | "No recent events" |
| Memory (no query) | `$memoryResults.length === 0 && !$memoryQuery` | "Enter a search query to browse memories." |
| Memory (no results) | `$memoryResults.length === 0 && $memoryQuery && !$isSearching` | "No memories found for [query]" |
| Learning (not connected) | `!$isConnected` | "Connect to the gateway to view learning discoveries." |
| Learning (no items) | `$learningItems.length === 0 && !$isLoadingLearning` | "No learning discoveries" + "Click Refresh to check for new discoveries from Eidolon." |
| Server discovery | `servers.length === 0` | "No servers found on your network" |
| Settings discovery | `discoveredServers.length === 0` after scan | "No servers found. Make sure the Eidolon server is running and broadcasting." |

All empty states are well-written with actionable guidance.

### 7.3 Error States

**Result: GOOD overall, 1 minor issue.**

| Error Scenario | Handling |
|----------------|----------|
| Daemon crash | `daemonError` banner with "Restart" and "Dismiss" buttons. Auto-restart on unexpected exit (rate-limited to 3 within 5 minutes). |
| WebSocket disconnection | Connection state changes to "disconnected", `clearStreamingState()` called, dashboard shows "Not connected" banner. Auto-reconnect with exponential backoff + jitter (up to 50 attempts). |
| WebSocket error | Connection state changes to "error", `clearStreamingState()` called. |
| Chat send failure | Error message replaces the "Thinking..." placeholder as a system message. |
| Memory search failure | `$memoryError` banner shown above results. |
| Memory delete failure | `$memoryError` banner shown. |
| Learning fetch failure | `$learningError` banner shown. |
| Settings update check failure | `updateError` banner shown. |
| Server discovery failure | `discoveryError` / `discoverError` shown. |
| Config validation failure | Falls through to onboarding flow. |
| Max reconnect attempts reached | Connection state stays "error". |

Error dismissibility:
- **Daemon error banner**: Dismissible via "Dismiss" button. GOOD.
- **Dashboard error banner**: Not dismissible (shows until next successful fetch clears it automatically). ACCEPTABLE -- auto-clears on success.
- **Memory error banner**: Not dismissible (shows until next search clears it). ACCEPTABLE.
- **Learning error banner**: Not dismissible. ACCEPTABLE.

**R7-L2: `dashboardError` banner is not dismissible by the user.**

The `error-banner` in `dashboard/+page.svelte` (line 183) has no dismiss button. If the error persists (e.g., server is down), the banner stays visible indefinitely. It does auto-clear when a successful `fetchStatus()` occurs, so this is low priority.

### 7.4 Navigation

**Result: GOOD -- no issues.**

- **Sidebar highlights current page**: `class:active={currentRoute === item.route}` and `aria-current={currentRoute === item.route ? "page" : undefined}`. The active nav item gets `background: var(--bg-tertiary)` and `color: var(--accent)`. GOOD.
- **No full page reloads**: Navigation is handled by `currentRoute` state variable in `App.svelte`. Clicking a nav item calls `navigate(route)` which sets `currentRoute`, causing Svelte to reactively show the correct page component. No browser navigation occurs. GOOD.
- **Skip-to-content link**: `<a class="skip-link" href="#main-content">Skip to main content</a>` with matching `id="main-content"` on `<main>`. Accessible keyboard navigation. GOOD.
- **Back navigation in onboarding**: Both `ServerSetup` and `ClientSetup` have "Back" buttons that call `onBack()`, returning to role selection. GOOD.

### 7.5 Responsive Design

**Result: ADEQUATE -- 1 minor issue.**

- **Dashboard cards**: Media query at 900px switches from 4-column to 2-column grid. At 500px switches to 1-column. GOOD.
- **Dashboard bottom row**: Media query at 700px switches from 2-column to 1-column. GOOD.
- **RoleSelect cards**: Media query at 600px switches from row to column layout. GOOD.
- **Onboarding panels**: `max-width: 520px` / `480px` with `width: 100%` -- responsive. GOOD.
- **Settings content**: `max-width: 560px` -- responsive. GOOD.
- **Chat messages**: `max-width: 80%` -- responsive. GOOD.
- **Memory detail panel**: `width: 360px; min-width: 360px` -- responsive concern noted below.
- **Sidebar**: Fixed `width: var(--sidebar-width)` with no collapse behavior.

**R7-L3: Memory page detail panel has a fixed 360px width with no responsive breakpoint.**

The memory page uses a side-by-side layout: results list (flex: 1) and detail panel (360px fixed). On narrow windows (under ~600px), the detail panel takes over half the width, squeezing the results list. There is no media query to stack these vertically on small screens.

**R7-L4: Sidebar has no collapse/responsive behavior.**

The sidebar uses `width: var(--sidebar-width)` (likely ~200px from CSS variables) with no media query to collapse on narrow windows. On very narrow windows, the sidebar and content together may overflow. Since Tauri apps typically have a minimum window size set in `tauri.conf.json`, this is less critical than it would be for a web app.

---

## Summary

### Round 6 Findings

| ID | Severity | Description | File |
|----|----------|-------------|------|
| R6-M1 | Medium | 4 `unwrap()` calls on serde_json that could panic if code is refactored | `commands.rs:814,841,1023,1062` |
| R6-M2 | Medium | `stop_daemon` poll loop acquires mutex lock on every iteration (50x/sec for up to 5s) | `commands.rs:303-318` |
| R6-L1 | Low | Unused `dashboardLoading` export -- defined but never consumed by any component | `dashboard.ts:272` |
| R6-L2 | Low | Connection error message is generic ("Connection failed") with no guidance | `connection.ts:34` |
| R6-L3 | Low | WebSocket creation error path produces no user-visible message (browser limitation) | `api.ts:301` |
| R6-L4 | Low | Mutex poisoning recovery via `into_inner()` may mask underlying panics | `commands.rs:188` (and 4 other locations) |

### Round 7 Findings

| ID | Severity | Description | File |
|----|----------|-------------|------|
| R7-L1 | Low | Dashboard shows default zeros during initial load (no loading indicator) | `dashboard/+page.svelte` |
| R7-L2 | Low | Dashboard error banner is not dismissible by the user | `dashboard/+page.svelte:183` |
| R7-L3 | Low | Memory detail panel has fixed 360px width, no responsive breakpoint for narrow screens | `memory/+page.svelte:357-358` |
| R7-L4 | Low | Sidebar has no collapse behavior for narrow windows | `+layout.svelte:94-96` |

### Totals

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 8 |

### Cumulative Status (Rounds 1-7)

All critical and high issues from Rounds 1-4 remain fixed and verified (confirmed in Round 5). The codebase is in good shape:

- Zero `as any` casts in the entire desktop frontend.
- All pages have empty states with actionable messages.
- Error states are handled consistently with dismissible banners where appropriate.
- Navigation works without reloads with proper active state highlighting.
- Responsive design covers the major breakpoints with media queries.
- The 2 medium findings (Rust `unwrap()` calls and mutex polling) are not correctness issues but could be hardened.

### Still Open from Prior Rounds (unchanged)

- R4-M4: Deprecated `Shell::open` (Rust warning)
- R4-M5: `setup_claude_token` macOS-only (uses osascript)
- R5-M1: `onNewClient` callback array has no unsubscribe -- **FIXED in current code** (line 20-26 of connection.ts returns an unsubscribe function, used at line 157 of App.svelte)
- R5-M2: Tray quit handler busy-waits on main thread -- **FIXED in current code** (uses `tokio::time::sleep` in async task, tray.rs lines 39-59)
- R5-M3: `setup_claude_token` polls with blocking I/O in async context -- **FIXED** (uses `tokio::task::spawn_blocking`)
- R5-M4: `push.taskStarted/taskCompleted` types never emitted (dead types in api.ts PushEventType)
- R4-L2: `rateMessage` uses `messageId` as `sessionId`
- R4-L3: `discover_servers` fails on co-located server -- **FIXED** (handles `AddrInUse`, returns empty list)
- R4-L4: `onboard_setup_server` hardcodes port 8419
- R5-L1: `appendStreamChunk` is dead code
- R5-L2: `cancelEdit/saveEdit` in memory page are unreachable -- **No longer present in code** (removed)

Corrected status: R5-M1, R5-M2, R5-M3, R4-L3, and R5-L2 are actually fixed in the current codebase.
