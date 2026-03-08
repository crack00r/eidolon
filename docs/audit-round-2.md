# Eidolon Desktop App Audit -- Round 2

**Date**: 2026-03-08
**Scope**: Full re-audit with fresh eyes. Covers Tauri backend, Svelte frontend, Core gateway, daemon wiring, Claude CLI integration, and end-to-end chat flow.
**Prior round**: Round 1 found 23 issues (3 critical, 4 high, 7 medium, 9 low). All critical/high/medium issues were fixed.

---

## Compilation Status

| Check | Result |
|-------|--------|
| TypeScript (`pnpm -r typecheck`) | 0 errors, 0 warnings |
| Rust (`cargo check`) | 0 errors, 1 warning (same deprecated `Shell::open` from Round 1) |
| Test suite (`pnpm -r test`) | 3112 pass, 6 skip, **0 fail** |

The Round 1 failing test (`buildClaudeArgs > basic prompt produces correct base args`) is now passing.

---

## Round 1 Fix Verification

All critical and high/medium fixes from Round 1 are confirmed applied:

| Issue | Status | Verification |
|-------|--------|-------------|
| C-1: `setupChatPushHandlers()` never called | **FIXED** | Called in `App.svelte` lines 98 and 156 via `wireChatPushHandlers()` |
| C-2: Memory `confidence` vs `importance` mismatch | **FIXED** | `memory.ts` line 60 maps `r.confidence` to `importance` with fallback |
| C-3: Dashboard `cognitiveState`/`connectedClients` mismatch | **FIXED** | `dashboard.ts` lines 98-119 handle both `state`/`cognitiveState` and number/array clients |
| H-1: Discovery shape mismatch | **FIXED** | `discovery.ts` lines 236-251 add fallback handler for Rust `DiscoveredServer` shape |
| M-1: `confidence` -> `importance` mapping | **FIXED** | Same as C-2 |
| M-3: Learning status `"new"` -> `"pending"` mapping | **FIXED** | `learning.ts` lines 62-67 map non-approved/non-rejected to `"pending"` |

---

## NEW Issues Found in Round 2

### HIGH Issues

#### H-1. Race condition: `wireChatPushHandlers()` may be called before WebSocket is connected

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/App.svelte` (lines 97-98, 155-156)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/connection.ts` (lines 29-48)

**What is wrong**: The sequence in `App.svelte` is:
```
await autoConnect(role);     // calls connect() which calls client.connect()
wireChatPushHandlers();      // calls getClient() and registers handlers
```

`connect()` in `connection.ts` creates the `GatewayClient`, stores it in the clientStore, and calls `client.connect()`. The `client.connect()` method is non-blocking -- it calls `establishConnection()` which creates a WebSocket but does not await its `onopen` event. So `wireChatPushHandlers()` runs immediately after, when the client object exists but the WebSocket is still in `connecting` state.

This is **not fatal** because `setupChatPushHandlers()` only registers event handlers on the client object (which exists), not on the WebSocket directly. The handlers are stored in `typedPushHandlers` and will fire when push events arrive later. So the race condition does not cause a bug per se. However, there is a subtle issue: if `connect()` fails and triggers a reconnect, or if the client is created anew (line 44 in `connection.ts`), the push handlers registered on the old client are lost. The `wireChatPushHandlers()` function is only called once and does not re-register after reconnection.

**Impact**: If the initial WebSocket connection fails and the client reconnects, or if `connect()` is called again from Settings (which disconnects and re-uses the same client object), the push handlers survive. But if a new client is created (first connect), and the connection fails before `wireChatPushHandlers` runs, `getClient()` will return the client and handlers will be registered. The handlers are on the client object, not the WebSocket, so they persist across reconnects. **Downgrading to MEDIUM** after analysis -- the handlers survive reconnects because they are on the `GatewayClient` instance, not the `WebSocket`.

**Revised severity**: MEDIUM

---

#### H-2. `setup_claude_token` blocking poll loop can freeze the Tauri async runtime

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 444-469)

**What is wrong**: The `setup_claude_token` command contains a polling loop with `std::thread::sleep(Duration::from_millis(500))` that runs for up to 180 seconds. This function is declared `pub async fn` but the body is synchronous -- it blocks the current thread with `std::thread::sleep`. In Tauri, async commands run on the Tokio runtime. Calling `std::thread::sleep` from an async context blocks the Tokio worker thread, potentially starving other async tasks (like the daemon monitor, WebSocket connections, etc.).

In contrast, `discover_servers` correctly uses `tokio::task::spawn_blocking` to run its blocking UDP listener on a dedicated thread.

**Impact**: While the auth setup is running (up to 3 minutes), other Tauri async commands may experience delayed execution. The daemon monitor task (`start_daemon` spawns an async task monitoring stdout/stderr) could miss events or buffer them.

**Fix**: Wrap the polling loop in `tokio::task::spawn_blocking`, or replace `std::thread::sleep` with `tokio::time::sleep(Duration::from_millis(500)).await`.

---

#### H-3. `onboard_setup_server` still returns double-encoded JSON string (Round 1 M-6 not fixed)

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 972, `Ok(result.to_string())`)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/onboarding/ServerSetup.svelte` (lines 101-103)

**What is wrong**: The Rust command's return type is `Result<String, String>`. It builds a `serde_json::Value` and then converts it with `result.to_string()`, producing a JSON string. Tauri serializes this string into the JSON-RPC response, resulting in double-encoding. The frontend works around this by checking `typeof rawResult === "string"` and calling `JSON.parse(rawResult)`.

This was flagged as M-6 in Round 1. The workaround in `ServerSetup.svelte` (line 101-103) works, but the root cause in the Rust command persists. Upgrading to HIGH because this pattern is fragile and any future consumer of `onboard_setup_server` would need to know about the double-encoding.

**Fix**: Change the return type to `Result<serde_json::Value, String>` and return `Ok(result)` instead of `Ok(result.to_string())`.

---

### MEDIUM Issues

#### M-1. `streamingStore` is set to `false` prematurely in `sendMessage`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (lines 89-91)

**What is wrong**: In `sendMessage`, the `finally` block at line 89-91 sets `streamingStore.set(false)` immediately after the `chat.send` RPC call completes. But `chat.send` returns `{ messageId, status: "queued" }` -- the actual response comes later via `push.chatMessage`. So the streaming state is:

1. Set to `true` at line 61
2. Set to `false` at line 90 (in `finally`, after `chat.send` returns)
3. The assistant message still shows `streaming: true` (content: "Thinking...")
4. The "Send" button becomes enabled again because `$isStreaming` is `false`
5. User can send another message while the first is still being processed
6. When `push.chatMessage` arrives, it sets `streamingStore.set(false)` again (redundant)

**Impact**: The user can rapid-fire multiple messages while the previous one is still being processed. Each new message creates a new "Thinking..." placeholder. When push responses arrive, they replace the **last** streaming placeholder (`findLastIndex`), meaning earlier messages may never get their responses replaced. This can lead to orphaned "Thinking..." messages.

**Fix**: Do not set `streamingStore.set(false)` in the `finally` block of `sendMessage`. Let the push handlers (`push.chatMessage`) be the sole authority for clearing the streaming state. Only set `false` in the error path (already handled at line 84).

---

#### M-2. `wireChatPushHandlers` is not called when reconnecting from Settings page

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/settings/+page.svelte` (line 80-81)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/App.svelte` (line 106-115)

**What is wrong**: The Settings page has a "Connect" button that calls `handleConnect()` which calls `connect()` from the connection store. This does NOT re-call `wireChatPushHandlers()`. However, looking at the connection store, `connect()` either disconnects/reconnects the same client object (line 41-42) or creates a new one (line 44). If a new client is created, the push handlers registered on the old client are lost.

The `connect()` function in `connection.ts` line 40-48:
```typescript
let client = get(clientStore);
if (client) {
  client.disconnect();
  client.updateConfig(config);  // reuse same client
} else {
  client = createClient(config);  // NEW client -- no push handlers
  clientStore.set(client);
}
client.connect();
```

On first connect from Settings, if a client already exists from `autoConnect`, it is reused and handlers survive. If `autoConnect` failed to create a client (threw before `createClient`), then Settings creates a new client without push handlers.

**Impact**: Edge case. If the initial connection completely failed (e.g., config check threw), and the user navigates to Settings to manually connect, the new client will not have chat push handlers. Chat messages will send but responses will never appear.

**Fix**: Either call `wireChatPushHandlers()` from the connection store after creating a new client, or move push handler registration into a reactive `$effect` that watches the client store.

---

#### M-3. `readOAuthToken()` method in `ClaudeCodeManager` is dead code

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/manager.ts` (lines 250-260)

**What is wrong**: The private method `readOAuthToken()` reads a token file from the config directory. It is never called anywhere in the class. The actual OAuth auth mechanism relies on `CLAUDE_CONFIG_DIR` env var (line 147) pointing Claude CLI to its own auth session, not on a token file. This is dead code left over from an earlier design.

**Impact**: None -- it is dead code. Minor code cleanliness issue.

---

#### M-4. Pairing URL in `ServerSetup.svelte` leaks auth token in UI text

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/onboarding/ServerSetup.svelte` (lines 109, 266-269)

**What is wrong**: After server setup completes, the pairing URL is displayed as `eidolon://host:port?token=xxx` where `xxx` is the actual 32-char hex auth token. This is shown in a `<code>` element in plain text. If the user screenshots the setup screen or shares it, the auth token is exposed.

**Impact**: Security risk if the user shares or screenshots the onboarding completion screen. The token is the gateway auth credential.

**Fix**: Mask the token in the display (e.g., show only the first 4 and last 4 characters), or provide a "Copy" button without displaying the full URL. Alternatively, add a warning that the URL contains a secret.

---

#### M-5. `setup_claude_token` uses hardcoded `/tmp` paths -- insecure on multi-user systems

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 397-398, 425-426)

**What is wrong**: The marker path `/tmp/eidolon-auth-done` and script path `/tmp/eidolon-auth.sh` are fixed locations in the world-readable `/tmp` directory. On a multi-user macOS system:
1. Another user could pre-create `/tmp/eidolon-auth-done` with content "success" to trick the polling loop into thinking auth succeeded when it didn't.
2. Another user could read `/tmp/eidolon-auth.sh` which contains the `CLAUDE_CONFIG_DIR` path (not secret, but reveals filesystem layout).
3. There's a TOCTOU (time-of-check-time-of-use) race between `std::fs::remove_file(marker_path)` at line 398 and the marker being read at line 450.

**Impact**: On single-user desktop systems (the typical case), this is negligible. On shared systems, it could lead to a spoofed auth success.

**Fix**: Use `std::env::temp_dir()` with a random suffix (e.g., `/tmp/eidolon-auth-{uuid}/`) and create the directory with 0700 permissions.

---

#### M-6. No error feedback to user when Claude returns empty response

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/daemon/event-handlers-user.ts` (lines 179-182)

**What is wrong**: When Claude returns an empty response (`responseText.length === 0`), the handler logs a warning and returns `{ success: true, tokensUsed: 0 }`. No message is routed back to the user's channel. The frontend will show "Thinking..." indefinitely because no `push.chatMessage` is ever sent.

Combined with M-1 (streaming flag cleared prematurely), the "Thinking..." placeholder will persist and the user can send more messages, each creating additional stuck placeholders.

**Impact**: The user sees a permanent "Thinking..." with no indication that something went wrong. The only remedy is clearing the chat.

**Fix**: When the response is empty, route an error/info message back to the channel (e.g., "I wasn't able to generate a response. Please try again.") so the frontend receives a `push.chatMessage` and clears the streaming state.

---

#### M-7. Dashboard `startDashboard()` does not check if already connected before subscribing

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/dashboard/+page.svelte` (lines 129-131)

**What is wrong**: The dashboard calls `startDashboard()` on mount. Inside `startDashboard`, `fetchStatus()` and `client.call("system.subscribe")` are called. If the gateway is not yet connected (e.g., the WebSocket is still in `connecting` state after app launch), `fetchStatus()` will silently return (line 139: checks `client.state !== "connected"`) and `trySubscribe()` will also bail (line 208: checks `client.state === "connected"`).

However, `startDashboard` does set up an `onStateChange` handler (line 219) that retries `trySubscribe()` when the state becomes `"connected"`. But it does NOT retry `fetchStatus()` on connect. So if the dashboard mounts before the WebSocket connects, the initial status fetch is lost and the user sees default/empty values until the next polling cycle (5 seconds later).

**Impact**: On app launch, the dashboard may show stale defaults for up to 5 seconds. Minor UX issue.

**Fix**: Add `fetchStatus()` inside the `onStateChange` handler alongside `trySubscribe()`.

---

### LOW Issues

#### L-1. Pairing URL token not URL-encoded in `ServerSetup.svelte`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/onboarding/ServerSetup.svelte` (line 109)

**What is wrong**: The pairing URL is built as `eidolon://${host}:${port}?token=${token}`. The token is a hex string (safe characters), so URL encoding is not strictly needed. But if the token format ever changes to include non-URL-safe characters, this would break. The `parsePairingUrl` in `ClientSetup.svelte` uses `parsed.searchParams.get("token")` which auto-decodes URL-encoded values, so the receiver side is correct.

**Impact**: Negligible with current hex tokens. Defensive improvement.

---

#### L-2. `connection.ts` `connect()` calls `client.disconnect()` then `client.updateConfig()` but does not re-register state handlers

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/connection.ts` (lines 40-48)

**What is wrong**: When reconnecting with an existing client, `connect()` calls `client.disconnect()` then `client.updateConfig(config)` then `client.connect()`. The `disconnect()` method clears `shouldReconnect` and rejects pending requests, but does NOT clear state handlers or push handlers. So all previously registered handlers (including the `onStateChange` from `createClient` at line 17) survive. This is actually correct behavior. Not a bug.

**Verdict**: After analysis, this is working as intended. No issue.

---

#### L-3. `sendMessage` does not debounce or throttle rapid submissions

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (line 32)

**What is wrong**: Combined with M-1 (streaming flag cleared prematurely), users can send messages in rapid succession. Each creates a `user:message` event on the backend's event bus. If the cognitive loop processes them sequentially, this could queue up many Claude CLI invocations.

**Impact**: Potential resource exhaustion if a user sends many messages quickly. Each message spawns a Claude CLI subprocess.

**Fix**: Either keep `isStreaming` true until the push response arrives (fixes M-1), or add a send cooldown/debounce.

---

#### L-4. `client.reportErrors` RPC call on connect may fail silently if handler not yet registered

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/api.ts` (lines 481-511)

**What is wrong**: When the WebSocket connection transitions to `"connected"`, `flushErrorBuffer()` fires immediately and calls `client.reportErrors`. If the server's auth handler has not yet processed (the auth response triggers the state change), the RPC call should work. However, if the gateway has a timing window where the client is `"connected"` in its local state but the server hasn't finished processing the auth, the call might fail. The code handles this gracefully at line 507-510 (best-effort, keeps buffer for next attempt).

**Impact**: None -- already handles the failure gracefully.

**Verdict**: Not an issue.

---

#### L-5. `open_external_url` allows `http://` URLs (not just `https://`)

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 47-56)

**What is wrong**: The URL validation allows both `http://` and `https://` schemes. On a desktop app this is standard behavior, but in a security-conscious context, opening unencrypted HTTP URLs could expose the user to MITM attacks on the opened page.

**Impact**: Very low. This is standard desktop app behavior. The URL is opened in the system's default browser which has its own security measures.

---

#### L-6. No maximum reconnect notification to user

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/api.ts` (lines 517-519)

**What is wrong**: When the reconnection attempts reach `MAX_RECONNECT_ATTEMPTS` (50), the client state is set to `"error"` and no more reconnection is attempted. The state change propagates to the UI as a generic "Connection failed" error in the connection store. However, there is no specific message telling the user that auto-reconnect has been exhausted and they need to manually reconnect via Settings.

**Impact**: The user sees "error" status in the sidebar but may not know they need to manually reconnect.

---

#### L-7. Checklist animation in `ServerSetup.svelte` is misleading

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/onboarding/ServerSetup.svelte` (lines 84-99)

**What is wrong**: The setup checklist has 5 items (generating master key, writing config, etc.). When `runSetup()` is called, only the first item is set to "running" (line 88). Then the entire `onboard_setup_server` Tauri command runs as a single operation. On success, ALL items are set to "done" simultaneously (lines 97-99). The user sees item 1 in "running" state, then all items jump to "done" at once. The intermediate steps never individually show as running/done.

**Impact**: Cosmetic -- the progress animation is misleading but functionally harmless.

---

#### L-8. `validate_config` runs `claude auth status` synchronously on the Tokio runtime

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 581-596)

**What is wrong**: Similar to H-2, `validate_config` is an `async fn` that calls `Command::new(&bin).args(["auth", "status"]).output()` synchronously. `Command::output()` blocks the thread while waiting for the subprocess to complete. This runs on the Tokio async runtime and can starve other tasks.

Unlike H-2 (which blocks for up to 3 minutes), this only blocks for as long as `claude auth status` takes (typically 1-2 seconds), so the impact is lower.

**Impact**: Brief thread starvation during validation. Low priority since it only runs at startup.

---

#### L-9. `discover_servers` binds to port 41920 which conflicts with a co-located server

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 67-71)

**What is wrong**: The function handles `AddrInUse` by returning an empty list (line 70), which is correct. However, the comment says "co-located server" -- meaning the discovery broadcaster on the same machine occupies port 41920. When running both server and client on the same machine, UDP discovery will never work for the client because the server already binds the port.

The HTTP fallback probe (in `discovery.ts`) covers this case for localhost. `ClientSetup.svelte` and `Settings.svelte` call the Rust command directly, which will return empty, but the HTTP probe in the fallback strategy should catch localhost.

**Impact**: On co-located setups, UDP discovery silently fails. The HTTP fallback works for localhost but not for discovering the local server via its non-loopback IP.

---

## Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| HIGH | 2 | Blocking async runtime in `setup_claude_token`; double-encoded JSON in `onboard_setup_server` |
| MEDIUM | 7 | Premature streaming flag clear; missing push re-registration; empty response stuck; pairing token leak; insecure `/tmp` paths; dead code; dashboard initial fetch |
| LOW | 6 | URL encoding; no reconnect exhaustion message; misleading checklist; blocking `validate_config`; co-located discovery; rapid-fire sends |

**No CRITICAL issues found.** All Round 1 critical fixes are confirmed working.

---

## Most Impactful Fixes (Priority Order)

1. **M-1 + M-6**: Fix the streaming flag lifecycle. Remove `streamingStore.set(false)` from `sendMessage`'s `finally` block, and send an error message back to the channel when Claude returns empty. This prevents orphaned "Thinking..." messages and allows rapid-fire message queueing.

2. **H-2**: Wrap the `setup_claude_token` polling loop in `tokio::task::spawn_blocking` to avoid starving the async runtime during the 3-minute auth flow.

3. **H-3**: Change `onboard_setup_server` return type to `Result<serde_json::Value, String>` to eliminate double-encoding.

4. **M-4**: Mask the auth token in the displayed pairing URL on the server setup completion screen.

5. **M-2**: Re-register chat push handlers when a new client is created in the connection store.
