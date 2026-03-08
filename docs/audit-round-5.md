# Eidolon Desktop App Audit -- Round 5

**Date**: 2026-03-08
**Scope**: Integration verification and regression checking. Full chat flow data-shape tracing, verification of all Round 1-4 fixes, Svelte component lifecycle analysis, cross-platform checks, and dead code scan.
**Prior rounds**: Round 1 (23 issues), Round 2 (15 issues), Round 3 (18 issues), Round 4 (18 issues). Approximately 60 unique issues found and fixed across rounds.

---

## Compilation Status

| Check | Result |
|-------|--------|
| TypeScript (`pnpm -r typecheck`) | 0 errors, 0 warnings across 6 packages |
| Rust (`cargo check`) | 0 errors, 1 warning (deprecated `Shell::open`, tracked since Round 1) |
| Test suite (`pnpm -r test`) | 3112 pass (2941 core + 171 cli), 6 skip, **0 fail** across 206 files |

---

## Section 1: Full Chat Flow Data-Shape Trace

### Step-by-step flow verification

**1. Frontend: `sendMessage()` in `chat.ts` (lines 32-98)**
- Creates user `ChatMessage` with `{id, role: "user", content, timestamp}`.
- Creates assistant placeholder: `{id: assistantId, role: "assistant", content: "Thinking...", timestamp, streaming: true}`.
- Sets `streamingStore` to `true`.
- Calls `client.call<{ messageId: string; status: string }>("chat.send", { text: content })`.
- On success: re-applies "Thinking..." only if the placeholder still has `streaming: true` (M-1 fix).
- On error: replaces placeholder with error text, sets `streaming: false`, clears `streamingStore`.

**2. Frontend: `GatewayClient.call()` in `api.ts` (lines 133-168)**
- Validates `currentState === "connected"`.
- Constructs JSON-RPC 2.0 request: `{jsonrpc: "2.0", id: string, method: "chat.send", params: {text}}`.
- Sends over WebSocket, awaits response via pending promise map.
- **Data shape sent**: `{jsonrpc: "2.0", id: "1", method: "chat.send", params: {text: string}}`.

**3. Backend: `createChatSendHandler` in `rpc-handlers-chat.ts` (lines 44-68)**
- Validates params with `ChatSendParamsSchema`: `{text: string(1..100000), channelId?: string(1..64)}`.
- Generates `messageId` via `randomUUID()`.
- Publishes to EventBus: `eventBus.publish("user:message", {messageId, channelId: "gateway", userId: clientId, text}, {source: "gateway", priority: "critical"})`.
- Returns: `{messageId: string, status: "queued"}`.
- **Data shape match**: Params `{text}` matches Zod schema. `clientId` is provided by GatewayServer's connection manager. Return type matches the generic type param in frontend `call<>`.

**4. Backend: `EventBus.publish()` in `event-bus.ts` (lines 48-118)**
- Generates event ID, persists to SQLite `events` table.
- Calls `notifySubscribers()` synchronously with `BusEvent<T>` containing `{id, type: "user:message", priority: "critical", payload: {messageId, channelId, userId, text}, source: "gateway", timestamp}`.
- **Data shape**: `BusEvent.payload` is typed as `unknown` at the subscriber level. Each handler must safely narrow.

**5. Backend: `handleUserMessage` in `event-handlers-user.ts` (lines 19-294)**
- Narrows `event.payload` safely: extracts `channelId`, `userId`, `text` with `typeof` guards.
- Validates `channelId` and `userId` are present (rejects with `success: false` if not).
- Prepares workspace (MEMORY.md, CLAUDE.md), invokes `claudeManager.run(text, options)`.
- Collects response text from stream events.
- Routes response via `messageRouter.routeOutbound({id: "resp-UUID", channelId, text: responseText, format: "markdown", replyToId: event.id, userId})`.
- **Data shape match**: The `OutboundMessage` has `userId` set to the original client's gateway ID. `channelId` is "gateway". This correctly targets the originating client.

**6. Backend: `ClaudeCodeManager.run()` in `manager.ts` (lines 59-241)**
- Builds CLI args via `buildClaudeArgs()` -- includes `--print`, `--output-format stream-json`, `--verbose`.
- Builds safe environment: whitelisted env vars + `CLAUDE_CONFIG_DIR` via `getEidolonClaudeConfigDir()`.
- Spawns `Bun.spawn([claudeBin, ...args])` with workspace cwd.
- Streams stdout line-by-line to `parseStreamLine()`, yields `StreamEvent` objects.
- On exit code != 0, yields error event + stderr.
- Always yields `{type: "done"}` at end.
- **Data shape**: Yields `StreamEvent` (text/tool_use/tool_result/system/error/done) from `@eidolon/protocol`.

**7. Backend: `parseStreamLine()` in `parser.ts` (lines 21-78)**
- Parses JSON from each stdout line.
- Maps `{type: "assistant", message: {type: "text", text}}` to `StreamEvent {type: "text", content, timestamp}`.
- Maps `{type: "result"}` with `tool_use_id` to `{type: "tool_result"}`, without to `{type: "text"}`.
- Maps `{type: "error"}` to `{type: "error", error}`.
- Unknown types become system messages (safe fallback).
- **Data shape match**: Output matches `StreamEvent` union type from protocol.

**8. Backend: `GatewayChannel.send()` in `gateway-channel.ts` (lines 43-71)**
- Constructs push event: `{jsonrpc: "2.0", method: "push.chatMessage", params: {id: message.id, text: message.text, format, replyToId, timestamp}}`.
- Reads `message.userId` as `targetClientId`.
- If `targetClientId` is set, calls `server.sendTo(targetClientId, pushEvent)` (targeted delivery).
- Otherwise, calls `server.broadcast(pushEvent)` (fallback).
- **Data shape match**: Push event matches `PushChatMessagePayload` interface from protocol. The `method` is `"push.chatMessage"` which matches the frontend handler registration.

**9. Frontend: `push.chatMessage` handler in `chat.ts` (lines 140-167)**
- Extracts `text` from `params.text` (string validation).
- Extracts `id` from `params.id` (string validation, fallback to `generateId()`).
- Finds last streaming assistant message via `findLastIndex`.
- If found: replaces content with server text, sets `streaming: false`, updates id.
- If not found: appends as new assistant message.
- Sets `streamingStore` to `false`.
- **Data shape match**: `params.text` is the response text from `GatewayChannel`. `params.id` is `"resp-UUID"` from the outbound message. Both are strings. The handler correctly handles the push payload.

### Flow Verdict: PASS

The entire chat message flow has consistent data shapes at every transition. No type mismatches, missing fields, or shape incompatibilities were found.

---

## Section 2: Verification of All Round 1-4 Fixes

### R1-C1: setupChatPushHandlers called -- CONFIRMED FIXED

`App.svelte` calls `wireChatPushHandlers()` in three places:
1. Line 135: after `handleOnboardingComplete()`
2. Line 208: in `onMount()` after initial connection
3. Lines 155-158: via `onNewClient()` callback whenever a new GatewayClient is created

The `onNewClient` callback pattern ensures handlers survive reconnection.

### R4-H1: CLAUDE_CONFIG_DIR set in sidecar -- CONFIRMED FIXED

`commands.rs` line 209: `env_vars.push(("CLAUDE_CONFIG_DIR".to_string(), get_eidolon_claude_config_dir()))` is present in `start_daemon`. The `get_eidolon_claude_config_dir()` function (lines 376-397) uses `PathBuf::join()` and handles macOS, Windows, and Linux paths.

### Session: findClaudeBinary working -- CONFIRMED FIXED

`commands.rs` lines 338-371: `find_claude_binary()` checks explicit paths, iterates nvm versions directory via `std::fs::read_dir` (M-6 fix), and falls back to `which claude`.

### Session: --verbose flag in args -- CONFIRMED PRESENT

`args.ts` line 19: `const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"]`.

### R1: GatewayChannel registered -- CONFIRMED FIXED

`gateway-wiring.ts` lines 139-157: Step "GatewayChannelWiring" creates `GatewayChannel`, calls `setServer()`, and registers with `messageRouter.registerChannel()`.

### R3-H1: userId flows through to GatewayChannel -- CONFIRMED FIXED

Full chain verified:
- `rpc-handlers-chat.ts` line 59: `userId: clientId` in EventBus payload
- `event-handlers-user.ts` line 28: extracts `userId` from payload
- `event-handlers-user.ts` lines 196, 209: passes `userId` in `routeOutbound()`
- `OutboundMessage` (messages.ts line 32): has `userId?: string`
- `gateway-channel.ts` line 63: reads `message.userId`, calls `sendTo()`

### R2-M1 / R4-M1: Streaming state managed -- CONFIRMED FIXED

- `chat.ts` lines 42-47: Prevents sending while streaming (M-2 fix).
- `chat.ts` lines 59-64: Placeholder created with "Thinking..." immediately (not after RPC, fixes M-1 race).
- `chat.ts` lines 78-80: Re-applies "Thinking..." only if `msg.streaming` still true (M-1 guard).
- `connection.ts` lines 30-31, 33-34: `clearStreamingState()` called on both "error" and "disconnected" state transitions (L-6 fix).

### R3-H2: Daemon auto-restart -- CONFIRMED FIXED

`App.svelte` lines 91-119:
- `canRestartDaemon()` rate-limits to 3 restarts within 5 minutes.
- `restartDaemon()` calls `startDaemonWithConfig()`, reconnects, and re-wires push handlers.
- `daemon-exit` event listener (lines 167-180) triggers auto-restart after 3-second delay for unexpected exits.

### R4-H2: CSP blocks remote WebSocket -- CONFIRMED FIXED

`tauri.conf.json` line 25: CSP now has `ws: wss:` in connect-src, allowing WebSocket to any origin. This enables Tailscale/LAN connections.

### R4-H3: push.taskCompleted dead handler -- CONFIRMED FIXED

The handler is removed from `chat.ts`. The file now only has the `push.chatMessage` handler (lines 140-167). The type still exists in `PushEventType` (api.ts line 30) and `GatewayPushType` (gateway.ts line 89) for potential future use, which is acceptable.

### R4-M3: stop_daemon blocking -- CONFIRMED FIXED

`commands.rs` lines 271-322: `stop_daemon` is now `async`, uses `tokio::time::sleep` (line 318) instead of `std::thread::sleep`.

### R4-M5: setup_claude_token macOS-only -- PARTIALLY ADDRESSED

`commands.rs` lines 421-534: Still uses `osascript` (macOS-specific, line 503). No `#[cfg(target_os)]` guard was added. However, the `setup_claude_token` function's `tokio::time::sleep` polling (line 533) was fixed. The macOS-only limitation remains an unfixed issue from R4-M5. See Section 5 for status.

### R4-L5: Duplicate RpcValidationError -- CONFIRMED FIXED

`rpc-handlers-chat.ts` line 10: `import { RpcValidationError } from "./rpc-schemas.ts"`. The local class definition is removed. Single canonical class in `rpc-schemas.ts` (line 14).

### R4-L8: Missing PushEventType values -- CONFIRMED FIXED

`api.ts` lines 39-41: `push.approvalRequested`, `push.approvalResolved`, and `system.statusUpdate` are all present in the `PushEventType` union.

---

## Section 3: Svelte Component Lifecycle Analysis

### App.svelte -- GOOD, minor concern

**Cleanup functions**:
- `unlistenDaemonExit` (Tauri event listener) -- cleaned up in `onDestroy` (line 161).
- `unsubChatPush` (push handler subscription) -- cleaned up in `onDestroy` (line 162).
- `onNewClient` callback registration (line 155) -- **NO CLEANUP**. See M-1 below.

### Dashboard -- GOOD

- `onMount`: starts polling + push subscription.
- `onDestroy`: stops polling, clears interval, unsubscribes push.
- Uptime ticker: `setInterval` in `onMount`, `clearInterval` in `onDestroy`.
- `$effect` for uptime tracking correctly captures reactive dependencies.

### Chat -- GOOD

- No `onMount`/`onDestroy` needed (push handlers managed by App.svelte).
- `$effect` for auto-scroll reads `$messages` reactively.
- Send button disabled while streaming (`$isStreaming`).

### Memory -- GOOD

- `debounceTimer` cleared in `onDestroy`.
- `$effect` for modal focus is lightweight and properly scoped.

### Learning -- ACCEPTABLE

- `onMount` fetches data. No cleanup needed (one-shot fetch, no subscriptions).

### Settings -- ACCEPTABLE

- `onMount` reads platform info. No subscriptions to clean up.

---

## Section 4: Cross-Platform Analysis

### Windows

**Paths**: All Rust path construction now uses `PathBuf::join()` (M-7 fix confirmed in `get_config_path_internal`, `get_eidolon_claude_config_dir`, `get_master_key_path`, `get_platform_dirs`). Path separator consistency is correct.

**stop_daemon**: Uses `child.kill()` on Windows (line 292), SIGTERM on Unix (line 286). Correct.

**graceful_stop_daemon (tray.rs)**: Windows branch takes ownership and calls `child.kill()` (lib.rs lines 35-39). Unix branch uses `libc::kill(SIGTERM)`. Correct.

### Linux

**Sidecar permissions**: No explicit `chmod +x` on the sidecar binary. Tauri's `externalBin` mechanism packages the binary in the bundle, but file permissions depend on the packaging format (AppImage, deb). AppImage preserves permissions. This is a packaging concern, not a code issue.

**HOME environment**: `get_eidolon_claude_config_dir` on Linux respects `XDG_CONFIG_HOME` (line 390). The sidecar now receives `CLAUDE_CONFIG_DIR` explicitly (H-1 fix), so XDG divergence is handled.

### macOS

**AppleScript**: `setup_claude_token` (line 503) uses `osascript` which is macOS-only. No `#[cfg(target_os)]` guard. This is R4-M5, still unfixed. See Section 5.

---

## Section 5: Remaining Unfixed Issues from Prior Rounds

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| R4-M4 | Medium | **UNFIXED** | Deprecated `Shell::open` -- still uses `tauri_plugin_shell::Shell::open` (line 54). Rust compiler warning persists. |
| R4-M5 | Medium | **UNFIXED** | `setup_claude_token` is macOS-only -- uses `osascript` with no platform guard. |
| R4-L2 | Low | **UNFIXED** | `rateMessage` passes `messageId` as `sessionId` in `feedback.submit`. |
| R4-L3 | Low | **UNFIXED** | `discover_servers` returns empty list on co-located server (EADDRINUSE). |
| R4-L4 | Low | **UNFIXED** | `onboard_setup_server` hardcodes port 8419 in response (line 1048). |

All critical and high issues from Rounds 1-4 are confirmed fixed.

---

## Section 6: New Issues Found

### HIGH Issues

None.

### MEDIUM Issues

### M-1. `onNewClient` callback array is append-only -- memory leak on repeated navigation

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/connection.ts` (line 16)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/App.svelte` (lines 155-158)

**What is wrong**: The `onNewClientCallbacks` array in `connection.ts` is a module-level array that callbacks are `push()`ed into (line 16). The `onNewClient()` function does not return an unsubscribe function. In `App.svelte` line 155, the callback is registered at module scope (not inside `onMount`), so it only runs once per app lifecycle. However, this is a SPA with no page refreshes, so the callback is effectively registered once.

The real concern is the API design: `onNewClient()` provides no way to unregister. If a future component calls `onNewClient()` inside `onMount` without cleanup, callbacks accumulate. For the current single call site this is not a leak, but the pattern is fragile.

**Impact**: No current memory leak. Potential for leaks if additional callers are added.

**Fix**: Return an unsubscribe function from `onNewClient()`:
```typescript
export function onNewClient(callback: (client: GatewayClient) => void): () => void {
  onNewClientCallbacks.push(callback);
  return () => {
    const idx = onNewClientCallbacks.indexOf(callback);
    if (idx !== -1) onNewClientCallbacks.splice(idx, 1);
  };
}
```

### M-2. Tray "Quit" handler busy-waits on the main thread, blocking the UI

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/tray.rs` (lines 39-52)

**What is wrong**: The tray quit handler calls `graceful_stop_daemon()` and then spins in a `loop` with `std::thread::sleep(Duration::from_millis(100))` for up to 5 seconds waiting for the daemon to exit. The `on_menu_event` closure runs on the Tauri main thread. This blocks the event loop during shutdown, preventing any other events from being processed.

This is the same pattern that was fixed in `stop_daemon` (R4-M3), but the tray handler was not updated. The `stop_daemon` command now uses `tokio::time::sleep`, but `on_menu_event` is synchronous and cannot use async.

**Impact**: The UI freezes for up to 5 seconds when the user clicks "Quit" from the tray menu. On macOS this may trigger the "Application Not Responding" spinner.

**Fix**: Either:
1. Spawn a `tauri::async_runtime::spawn` task for the poll loop and call `app.exit(0)` from within it, or
2. Since the app is quitting anyway, reduce the timeout to 1 second and accept a possibly unclean daemon shutdown, or
3. Use `app.exit(0)` immediately and let the OS clean up the sidecar child process.

### M-3. `setup_claude_token` uses `std::time::Instant` poll loop that blocks the tokio runtime

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 506-534)

**What is wrong**: After launching the Terminal window, the function polls for the marker file in a loop using `tokio::time::sleep` (line 533, correctly async). However, the `std::fs::read_to_string` call (line 516) is a blocking I/O operation called from an async context. While individual reads are fast, this happens every 500ms for up to 180 seconds (360 iterations).

More critically, there is no cancellation mechanism. If the user dismisses the Terminal window without completing auth, the function blocks for the full 3-minute timeout. The frontend shows no progress indicator and the Tauri IPC call remains pending.

**Impact**: The auth setup flow blocks a Tauri async runtime thread for up to 3 minutes if the user abandons the Terminal window. Other async commands may queue behind it.

**Fix**: Use `tokio::fs::read_to_string` or `tokio::task::spawn_blocking` for the file reads. Consider exposing a cancellation mechanism to the frontend.

### M-4. `push.taskCompleted` and `push.taskStarted` remain in PushEventType but are never emitted

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/api.ts` (lines 29-30)
- `/Users/manuelguttmann/Projekte/eidolon/packages/protocol/src/types/gateway.ts` (lines 88-89)

**What is wrong**: While the `push.taskCompleted` handler was correctly removed from `chat.ts` (R4-H3 fix), the type strings `push.taskStarted` and `push.taskCompleted` remain defined in both the protocol `GatewayPushType` and the desktop `PushEventType`. A grep across the entire backend confirms that neither event is ever emitted. These are dead type members.

**Impact**: No functional impact, but misleads developers into thinking these events are available. A future developer may write handlers for events that never fire.

**Fix**: Either remove these types from both `GatewayPushType` and `PushEventType`, or add backend emission at the cognitive loop level when tasks start/complete. If the types are being kept for future use, add a comment documenting that they are reserved.

---

### LOW Issues

### L-1. `appendStreamChunk` function in chat.ts is exported but never called

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (lines 101-105)

**What is wrong**: The `appendStreamChunk(messageId, chunk)` function is designed for incremental streaming updates. However, the current architecture delivers the complete response in a single `push.chatMessage` event (not chunked). No call site exists in the desktop app. This is dead code left over from an earlier streaming design.

**Impact**: Dead code, no functional impact.

**Fix**: Remove the function, or keep it with a comment indicating it is reserved for future streaming support.

### L-2. `cancelEdit` and `saveEdit` in memory page are unreachable

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/memory/+page.svelte` (lines 91-107)

**What is wrong**: The `startEdit` function is commented out (lines 85-89) because `memory.update` RPC is not implemented. However, `cancelEdit` and `saveEdit` remain as live functions. With `editMode` never set to `true` (only `startEdit` can set it), neither function can ever execute. Additionally, `editContent`, `editImportance`, and `editMode` state variables (lines 24-26) are never used.

**Impact**: ~20 lines of dead code in the memory page component.

**Fix**: Comment out `cancelEdit`, `saveEdit`, and the unused state variables alongside `startEdit`, or remove them entirely until `memory.update` is implemented.

### L-3. `push.taskStarted` in PushEventType has no handler registered anywhere

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/api.ts` (line 29)

**What is wrong**: `push.taskStarted` is defined as a valid push event type but no component or store registers a handler for it via `client.on("push.taskStarted", ...)`. Combined with the backend never emitting it, this is doubly dead.

**Impact**: No functional impact. Covered by M-4 above for the type definition, but noted separately because the frontend has no handler for it at all.

### L-4. `handleSend` in ChatPage calls `scrollToBottom` after `await sendMessage` but before push arrives

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/chat/+page.svelte` (lines 25-36)

**What is wrong**: `handleSend` calls `scrollToBottom()` on line 35 after `await sendMessage()`. The `sendMessage` promise resolves when the RPC returns `{messageId, status: "queued"}`, not when the AI response arrives. The actual response arrives asynchronously via `push.chatMessage`, which adds a new message to the store. The `$effect` on line 53-56 watches `$messages` and scrolls on change, so the response message scroll is actually handled correctly by the effect.

The `scrollToBottom()` on line 35 is redundant with the `$effect` -- the effect already triggers for the user message and the placeholder. This is not a bug, just unnecessary code.

**Impact**: No functional impact. Slight redundancy.

**Fix**: Remove the explicit `scrollToBottom()` call on line 35 since the `$effect` handles all message changes.

---

## Regression Check Summary

### All confirmed fixes from Rounds 1-4 remain intact:

| Fix | Status |
|-----|--------|
| R1-C1: setupChatPushHandlers called | INTACT |
| R1-C2: GatewayChannel registered in wiring | INTACT |
| R3-H1: userId flows end-to-end | INTACT |
| R3-H2: Daemon auto-restart with rate limiting | INTACT |
| R4-H1: CLAUDE_CONFIG_DIR in sidecar env | INTACT |
| R4-H2: CSP allows ws:/wss: for remote connections | INTACT |
| R4-H3: push.taskCompleted dead handler removed | INTACT |
| R4-M1: Race condition guard on placeholder update | INTACT |
| R4-M2: Send-while-streaming prevention | INTACT |
| R4-M3: Async stop_daemon with tokio::time::sleep | INTACT |
| R4-M6: nvm glob resolution via read_dir | INTACT |
| R4-M7: PathBuf::join for cross-platform paths | INTACT |
| R4-L5: Single RpcValidationError class | INTACT |
| R4-L6: clearStreamingState on disconnect | INTACT |
| R4-L8: PushEventType includes approval + statusUpdate | INTACT |

### No regressions detected.

All 3112 tests pass. TypeScript typecheck clean. Only the existing Rust deprecation warning for `Shell::open` persists.

---

## Verified Good Patterns

1. **Chat store M-2 fix is elegant**: The synchronous `streamingStore.subscribe()` call with immediate unsubscribe (`()`) on line 44 is a correct Svelte pattern for reading a store value imperatively without creating a lasting subscription. This prevents the "rapid send" orphan placeholder issue.

2. **Connection store cleanup is thorough**: `clearStreamingState()` is called on both "error" and "disconnected" state transitions. The `rejectAllPending()` in GatewayClient ensures no promise leaks on disconnect.

3. **Dashboard lifecycle is clean**: `startDashboard()` calls `stopDashboard()` first (line 199), preventing duplicate poll intervals. The chained unsubscribe pattern (lines 228-232) correctly cleans up both the push handler and the state change handler.

4. **CSP is now correctly permissive for WebSocket**: `connect-src 'self' ws: wss:` allows WebSocket to any origin while still restricting HTTP to localhost. This is the right balance for the desktop app where the WebView is sandboxed.

5. **Event handler error isolation**: Both `EventBus.safeInvoke()` and `GatewayClient` typed handler dispatch wrap handler calls in try/catch, preventing one bad handler from killing the dispatch loop.

6. **Workspace cleanup is guaranteed**: `event-handlers-user.ts` uses try/finally (line 285-288) to always call `workspacePreparer.cleanup(sessionId)`, even when Claude errors or message routing fails.

---

## Summary

| Severity | Count | Source |
|----------|-------|--------|
| Critical | 0 | -- |
| High | 0 | -- |
| Medium | 4 | All new |
| Low | 4 | All new |
| Prior unfixed | 5 | R4-M4, R4-M5, R4-L2, R4-L3, R4-L4 |

**Key themes this round:**
- The full chat flow data shapes are consistent end-to-end. No integration mismatches found.
- All critical and high fixes from Rounds 1-4 remain intact with zero regressions.
- The remaining issues are low-severity: dead code, API design fragility, and one main-thread blocking pattern in the tray handler.
- Cross-platform path handling is now consistent thanks to PathBuf::join usage.
- The tray quit handler (M-2) is the most impactful new finding -- a copy of the same busy-wait pattern that was fixed in stop_daemon.

**Overall assessment**: The desktop app's integration layer is solid. The chat flow works correctly end-to-end with proper userId targeting, streaming state management, and error recovery. The codebase has matured significantly across 5 audit rounds, with approximately 60 issues identified and the vast majority fixed. The remaining issues are all medium or low severity with no functional blockers.
