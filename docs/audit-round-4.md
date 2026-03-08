# Eidolon Desktop App Audit -- Round 4

**Date**: 2026-03-08
**Scope**: Edge cases and integration testing. Deep code-path tracing for sidecar binary resolution, config file write paths, GatewayChannel wiring, chat store state machine, OutboundMessage userId flow, frontend push event handling, and regression checks from Round 3 fixes.
**Prior rounds**: Round 1 (23 issues), Round 2 (15 issues), Round 3 (18 issues). All critical and high issues from Rounds 1-3 are confirmed fixed.

---

## Compilation Status

| Check | Result |
|-------|--------|
| TypeScript (`pnpm -r typecheck`) | 0 errors, 0 warnings across 6 packages |
| Rust (`cargo check`) | 0 errors, 1 warning (deprecated `Shell::open`, same as prior rounds) |
| Test suite (`pnpm -r test`) | 3303 pass, 6 skip, **0 fail** across 218 files |

---

## HIGH Issues

### H-1. Sidecar does not pass CLAUDE_CONFIG_DIR to daemon process -- daemon uses user's global Claude session

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 193-217, `start_daemon`)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/manager.ts` (line 144)

**What is wrong**: The `start_daemon` command spawns the eidolon-cli sidecar with only the `EIDOLON_MASTER_KEY` environment variable. It does NOT pass `CLAUDE_CONFIG_DIR`. Meanwhile, the TypeScript daemon's `ClaudeManager.buildSafeEnv()` (manager.ts:144) explicitly sets `CLAUDE_CONFIG_DIR` to Eidolon's own config directory via `getEidolonClaudeConfigDir()`.

However, the Tauri sidecar environment is NOT the same as the Bun process environment. Tauri sidecars do NOT inherit the parent process's full environment by default on macOS (App Sandbox). The `setup_claude_token` command carefully sets up a separate Claude session in `~/Library/Preferences/eidolon/claude-config/` and the helper script explicitly exports `CLAUDE_CONFIG_DIR`. But the sidecar spawned by `start_daemon` never receives this directory path as an environment variable.

The daemon process (eidolon-cli) runs as a Bun process, which inherits whatever env Tauri passes. Since `CLAUDE_CONFIG_DIR` is not set, the daemon's ClaudeManager computes `getEidolonClaudeConfigDir()` at runtime, which resolves to the same `~/Library/Preferences/eidolon/claude-config/` path. This works on macOS because the Bun process and the Rust process share the same HOME directory. However:

1. On Linux, the sidecar might not have the same HOME (e.g., AppImage sandbox).
2. If `XDG_CONFIG_HOME` is set in the parent but not inherited by the sidecar, the paths diverge.
3. The Tauri sidecar does not inherit arbitrary environment variables -- only those explicitly passed via `.env()`.

**Impact**: On non-macOS platforms, or when XDG variables are customized, the daemon may attempt to use a Claude auth session that does not exist (the one at default XDG paths) instead of the one set up by `setup_claude_token` (which used the Rust-computed path). Claude CLI invocations would fail with "not authenticated" errors.

**Fix**: In `start_daemon`, add `CLAUDE_CONFIG_DIR` to the `env_vars` list:
```rust
env_vars.push(("CLAUDE_CONFIG_DIR".to_string(), get_eidolon_claude_config_dir()));
```

### H-2. CSP blocks WebSocket connections to remote servers (Tailscale/LAN IPs)

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/tauri.conf.json` (line 25)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/api.ts` (line 294)

**What is wrong**: The CSP `connect-src` directive is:
```
ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:* https://127.0.0.1:* ws://localhost:* wss://localhost:* http://localhost:* https://localhost:* ipc: http://ipc.localhost
```

This only allows connections to `127.0.0.1` and `localhost`. When the desktop app is configured as a **client** connecting to a **remote server** (the primary use case for Tailscale -- e.g., `ws://100.64.1.2:8419/ws` or `ws://192.168.1.50:8419/ws`), the WebSocket connection will be **blocked by CSP**.

The Round 3 audit memory note says "CSP has `connect-src *`" but that is outdated -- the actual CSP was tightened (correctly) to localhost-only. However, this broke the remote client use case.

The `GatewayClient.establishConnection()` (api.ts:294) constructs the URL as `${scheme}://${this.config.host}:${this.config.port}/ws` where `host` can be any IP address from config.

**Impact**: **All client-mode connections to remote servers silently fail.** The WebSocket constructor may throw or silently be blocked. The app shows "connecting..." indefinitely for any non-localhost gateway. This affects the core multi-device scenario (MacBook client connecting to Ubuntu server over Tailscale).

**Fix**: Either:
1. Use Tauri's runtime CSP modification to dynamically add the configured gateway host, or
2. Add common private network ranges: `ws://10.*:* ws://172.16.*:* ws://192.168.*:* ws://100.*:*` (the 100.x.x.x range covers Tailscale CGNAT), or
3. Use `connect-src 'self' ws: wss: http: https: ipc: http://ipc.localhost` (broadest, but safe since the app only connects to the configured gateway).

Option 2 is recommended as it is specific enough to avoid external connections while covering all LAN/VPN scenarios.

### H-3. `push.taskCompleted` handler in chat store listens for an event never emitted by the backend

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (lines 133-146)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/daemon/event-handlers-user.ts` (lines 203-210)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/gateway-channel.ts` (line 51)

**What is wrong**: The chat store registers a handler for `push.taskCompleted` (line 133) that is supposed to replace the "Thinking..." placeholder with the AI response. However, the backend **never emits** `push.taskCompleted`. I searched the entire `packages/core/src/` directory and found zero emitters of this event type.

The actual response delivery path is:
1. `user:message` event is processed by `handleUserMessage()` in `event-handlers-user.ts`
2. Response is sent via `messageRouter.routeOutbound()` with `channelId: "gateway"` and `userId` set to the client ID
3. `MessageRouter` routes to `GatewayChannel.send()`
4. `GatewayChannel.send()` emits `push.chatMessage` (line 51)
5. The chat store's `push.chatMessage` handler (line 148) processes the response

So the `push.chatMessage` handler (lines 148-175) is the **correct and only** path that works. The `push.taskCompleted` handler (lines 133-146) is dead code.

**Impact**: No functional impact currently since `push.chatMessage` handles the response correctly. However, this dead handler causes confusion, and if a future developer assumes `push.taskCompleted` is the primary path, they might break the `push.chatMessage` handler thinking it's redundant.

**Fix**: Remove the `push.taskCompleted` handler from the chat store. It is vestigial code from an earlier design and will never fire.

---

## MEDIUM Issues

### M-1. Chat store race condition: push arrives before `sendMessage` sets streaming placeholder

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (lines 49-73)

**What is wrong**: In `sendMessage()`, the flow is:
1. Line 49: Add user message to store
2. Line 60: Add assistant placeholder (empty content, streaming=true)
3. Line 64: `await client.call("chat.send", ...)` -- sends RPC, awaits response
4. Line 71: Update placeholder to "Thinking..."

Between step 3 (RPC sent) and step 4 (placeholder updated), the server could process the message and send back `push.chatMessage` via the GatewayChannel. If the backend processes the message fast enough (e.g., cached response or very short message), the push could arrive **before** step 4 updates the placeholder.

The `push.chatMessage` handler uses `findLastIndex` for a streaming assistant message. The placeholder at step 2 has `content: ""` and `streaming: true`, so the push handler would find it and replace it. This path actually works correctly for the fast-response case.

However, if the push arrives **after step 3 returns but before step 4 executes**, both the push handler and step 4 would be updating the same message in rapid succession. The push handler sets `streaming: false` and adds the real content, then step 4 overwrites it with `content: "Thinking..."` and `streaming: true`. The response is lost and the UI shows "Thinking..." permanently.

**Impact**: On fast servers or short messages, the AI response can be overwritten by the "Thinking..." placeholder, leaving the UI stuck. This is a race condition that depends on event loop timing.

**Fix**: Move the "Thinking..." content to step 2 (the initial placeholder creation) instead of step 4, or check if the message is still streaming before updating in step 4:
```typescript
messagesStore.update((msgs) =>
  msgs.map((msg) => (msg.id === assistantId && msg.streaming ? { ...msg, content: "Thinking..." } : msg)),
);
```

### M-2. Rapid message sends create orphaned "Thinking..." placeholders

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (lines 60-61, 139, 157)

**What is wrong**: If the user sends multiple messages quickly (before the first response arrives), each call to `sendMessage()` creates a new assistant placeholder with `streaming: true`. When the first `push.chatMessage` arrives, the handler uses `findLastIndex` to find the **last** streaming assistant message -- which would be the placeholder for the **most recent** send, not necessarily the one corresponding to this response.

The server processes messages in order via the event bus (FIFO within priority), so responses arrive in order. But the `push.chatMessage` event does not carry any correlation ID that maps it back to a specific user message or placeholder. The `id` field in the push event is set by the backend (`resp-${randomUUID()}`), which is different from the frontend's placeholder ID.

**Impact**: When sending multiple messages rapidly, responses may be matched to the wrong placeholder. Earlier placeholders remain stuck in "Thinking..." state permanently. The streaming store is set to false on the first response, so subsequent responses would not trigger `streamingStore.set(false)` again (it already is false), but the `push.chatMessage` handler still works because it falls through to the "append as new message" path (line 162-173) when no streaming placeholder is found. The result is a disjointed conversation display with orphaned "Thinking..." messages.

**Fix**: Add a `correlationId` or `replyToId` to the push event so the frontend can match responses to specific requests. Until then, consider disabling the send button while streaming (the `isStreaming` store already exists for this purpose).

### M-3. `stop_daemon` busy-waits on the main thread, blocking Tauri event loop

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 269-316)

**What is wrong**: `stop_daemon` is a synchronous Tauri command that spins in a loop with `std::thread::sleep(Duration::from_millis(100))` up to 5 seconds waiting for the daemon to exit. This blocks the Tauri main thread, preventing other IPC calls and window events from being processed.

The monitor task (lines 241-263) clears the daemon state asynchronously when the process terminates. But `stop_daemon` polls this state synchronously, holding the mutex repeatedly during the 5-second window.

**Impact**: While `stop_daemon` is running, the UI freezes for up to 5 seconds. Other Tauri commands (like `daemon_running`) will block waiting for the mutex. The tray menu becomes unresponsive.

**Fix**: Make `stop_daemon` an `async` command and use `tokio::time::sleep` instead of `std::thread::sleep`. Use `tokio::time::interval` for polling, or better yet, use a tokio `Notify` or `oneshot` channel from the monitor task to signal daemon exit.

### M-4. Deprecated `tauri_plugin_shell::Shell::open` -- Tauri migration needed

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 54)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/Cargo.toml`

**What is wrong**: The `open_external_url` function uses `Shell::open()` which is deprecated in favor of `tauri-plugin-opener`. This has been flagged in all four audit rounds. While the function still compiles, it may be removed in a future Tauri 2.x release.

**Impact**: Build breakage when upgrading to newer Tauri versions.

**Fix**: Replace `tauri_plugin_shell::ShellExt::shell(&app).open(&url, None)` with `tauri_plugin_opener`. Add `tauri-plugin-opener` to Cargo.toml and update the command.

### M-5. `setup_claude_token` is macOS-only -- uses AppleScript to open Terminal

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 391-505)

**What is wrong**: The `setup_claude_token` command uses `osascript` to open Terminal.app with a bash script. This only works on macOS. On Linux, the `osascript` command does not exist and the function will return an error. On Windows, neither `osascript` nor the bash script path will work.

The Tauri app is configured to build for all platforms (`"targets": "all"` in tauri.conf.json), and the function does not have any `#[cfg(target_os)]` guards.

**Impact**: Claude authentication setup silently fails on Linux and Windows. Users on these platforms cannot complete onboarding.

**Fix**: Add platform-specific terminal opening:
- Linux: `x-terminal-emulator -e bash` or `gnome-terminal -- bash`
- Windows: `cmd.exe /c start`
- Alternatively, use `std::process::Command::new("bash")` directly and capture stdout/stderr in the Tauri async context, displaying the auth URL in the desktop UI instead of relying on a terminal.

### M-6. `find_claude_binary` nvm glob path never resolves

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 339)

**What is wrong**: The candidate path `format!("{}/.nvm/versions/node/*/bin/claude", home)` contains a literal `*` glob character. `std::path::Path::new(path).exists()` does not expand glob patterns -- it checks for a file literally named `*`, which never exists. The comment "won't work with glob but fallback" acknowledges this, but the fallback to `which claude` only works when launched from a terminal (Tauri apps don't inherit the user's shell PATH on macOS).

**Impact**: On macOS, if Claude is installed via nvm, the binary is not found. The `which` fallback also fails because Tauri apps don't inherit shell PATH. Users who installed Claude via nvm cannot complete onboarding.

**Fix**: Use `std::fs::read_dir` to iterate the nvm versions directory and check each version's bin directory. Or use `glob` crate to expand the pattern.

### M-7. Config path inconsistency between Rust (Tauri) and TypeScript (daemon) on Windows

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 524-536, `get_config_path_internal`)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/config/paths.ts` (lines 49-61, `getConfigDir`)

**What is wrong**: On Windows, the Rust config path is:
```
%APPDATA%/eidolon/config/eidolon.json
```
While the TypeScript config path is:
```
%APPDATA%/eidolon/config/eidolon.json
```
These match. However, on **Windows**, the Rust code uses `std::env::var("APPDATA")` while the TypeScript code uses `process.env.APPDATA`. If the Tauri app is launched with a different APPDATA (e.g., running as a different user or in a sandbox), the paths could diverge.

More critically, the Rust code uses forward slashes (`format!("{}/eidolon/config/eidolon.json", appdata)`) while Node/Bun on Windows normalizes to backslashes via `path.join()`. While Windows accepts both, this could cause string-comparison mismatches if the daemon tries to compare or watch config paths.

**Impact**: Low on macOS/Linux (paths match). Potential config-not-found errors on Windows if environment differs between Tauri and sidecar.

**Fix**: Use `std::path::PathBuf::push()` instead of `format!()` for path construction in Rust, ensuring platform-correct separators.

---

## LOW Issues

### L-1. Gateway channel test uses mock that does not verify `sendTo` targeting

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/__tests__/gateway-channel.test.ts` (line 64)

**What is wrong**: The test "send broadcasts push.chatMessage to server" creates a mock GatewayServer that only tracks `broadcast()` calls in a `broadcasts[]` array. It does not test the `sendTo()` path (when `userId` is provided in the OutboundMessage). Since the Round 3 fix added targeted delivery via `userId`, the test should verify both the broadcast fallback and the targeted `sendTo` path.

**Fix**: Add a test case that sends an OutboundMessage with `userId` set, and verify that `sendTo` is called with the correct client ID instead of `broadcast`.

### L-2. Chat store `rateMessage` uses `messageId` as both `sessionId` and `messageId` in feedback

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (lines 111-112)

**What is wrong**: `rateMessage` passes `messageId` as the `sessionId` parameter in the `feedback.submit` RPC call. The feedback backend expects `sessionId` to be a Claude session ID (like `msg-uuid`), not a frontend message ID (like `msg-uuid`). While they happen to have the same format, they refer to different entities and the feedback record will not be correlatable to the actual Claude session.

**Fix**: Either track the sessionId from the backend response or remove the sessionId parameter from the feedback call if it's not meaningful at the frontend level.

### L-3. `discover_servers` binds to port 41920 which conflicts with the server's broadcast port

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 67)

**What is wrong**: The discovery listener binds to `0.0.0.0:41920`. The `DiscoveryBroadcaster` on the server side sends UDP datagrams TO port 41920. This works for remote discovery. However, if the desktop app is running on the same machine as the server, the `EADDRINUSE` error at line 69 correctly returns an empty list. But this means **co-located discovery always fails** -- the server cannot discover itself.

The `EADDRINUSE` handling (line 69-72) silently returns an empty list, which means the onboarding UI shows "No servers found" even when a server is running locally.

**Fix**: When `EADDRINUSE` is detected, return a synthetic entry for `127.0.0.1:8419` (the default), or attempt to connect directly to localhost as a fallback discovery mechanism.

### L-4. `onboard_setup_server` hardcodes port 8419 in the response but config is mutable

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 1007)

**What is wrong**: The response from `onboard_setup_server` always returns `"port": 8419`, but the config written to disk also has `"port": 8419` in the gateway section. If the user later changes the port in the config file (or if a future version supports custom ports during setup), the initial response and QR code will show the wrong port.

**Fix**: Read the port from the config object that was just written instead of hardcoding.

### L-5. Multiple `RpcValidationError` class definitions

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/rpc-handlers-chat.ts` (lines 42-47)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/rpc-schemas.ts`

**What is wrong**: `rpc-handlers-chat.ts` defines its own local `RpcValidationError` class (line 42) while the canonical version exists in `rpc-schemas.ts`. The import at the top of rpc-handlers-chat.ts does not import `RpcValidationError` from rpc-schemas.ts. The local class has the same name and shape, but `instanceof` checks will fail across module boundaries.

**Impact**: If gateway error handling checks `err instanceof RpcValidationError` (from rpc-schemas.ts), errors thrown from rpc-handlers-chat.ts will not match, and will be treated as internal errors (500) instead of validation errors (400).

Looking at `client-manager.ts` line 245-248: it does check `err instanceof RpcValidationError` from the imported `rpc-schemas.ts` module. So chat validation errors from rpc-handlers-chat.ts produce a wrong error code.

**Fix**: Remove the local `RpcValidationError` class from `rpc-handlers-chat.ts` and import it from `rpc-schemas.ts`.

### L-6. `streamingStore` never cleared if server disconnects mid-response

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (lines 187-190)

**What is wrong**: `clearStreamingState()` exists (line 188) but is only useful if called externally. Looking at the connection store, when the WebSocket disconnects, `rejectAllPending` is called in `GatewayClient` but nothing calls `clearStreamingState()`. The UI will show the streaming indicator permanently after a disconnect during an active response.

**Fix**: Call `clearStreamingState()` in the connection state change handler when state transitions to `disconnected` or `error`.

### L-7. `GatewayClient` does not validate JSON-RPC version on push notifications

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/api.ts` (lines 416-417)

**What is wrong**: The push notification dispatch path (line 417) only checks `message.id === undefined && message.method` to identify a push. But line 408-414 already validates `message.jsonrpc !== "2.0"` and would reject invalid messages. However, the validation at line 408 also requires either `result`, `error`, or `method` to be present. A malformed message with `jsonrpc: "2.0"` and just `method` (no `id`, `result`, or `error`) passes validation and reaches the push path. This is correct behavior -- but the type of `message.method` is not narrowed. If the server sends a push with `method: 123` (number instead of string), the typed handler lookup (`this.typedPushHandlers.get(message.method)`) would fail silently since Map.get with a number key won't match any string key.

**Impact**: Minimal -- the server always sends string methods. But a malicious server could cause silent handler drops.

**Fix**: Add `typeof message.method === "string"` check before dispatch.

### L-8. `PushEventType` in api.ts does not include `push.approvalRequested` and `push.approvalResolved`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/api.ts` (lines 27-39)
- `/Users/manuelguttmann/Projekte/eidolon/packages/protocol/src/types/gateway.ts` (lines 86-100)

**What is wrong**: The protocol's `GatewayPushType` includes `push.approvalRequested` and `push.approvalResolved`, but the desktop client's `PushEventType` union does not. If the frontend tries to register a typed handler for these events, TypeScript will produce a compile error.

**Fix**: Add `push.approvalRequested` and `push.approvalResolved` to the `PushEventType` union in api.ts, or better yet, import `GatewayPushType` from `@eidolon/protocol` instead of maintaining a duplicate.

---

## Regression Check from Round 3 Fixes

### CSP Change (Round 3 L-7)
Round 3 reported that CSP had `connect-src *` and recommended tightening. The current CSP is tightened to localhost-only, which is correct for local server mode. However, this introduced **H-2** above -- remote client connections are now blocked. The fix was too aggressive.

### OutboundMessage userId (Round 3 H-1)
**Confirmed fixed.** `OutboundMessage` now has `userId?: string` (messages.ts line 32). `event-handlers-user.ts` passes `userId` in both the success path (line 209) and the empty-response path (line 196). `GatewayChannel.send()` reads `message.userId` directly (line 63) and calls `sendTo()` for targeted delivery. The cast workaround is removed.

### Event retry limit (Round 3 M-1)
No regression detected. The event retry change was in the EventBus and does not affect any desktop-facing code paths.

### No test failures
All 3303 tests pass (3303 = 35 web + 100 protocol + 32 desktop + 24 test-utils + 2941 core + 171 cli). This is up from 3112 in Round 3, confirming new test coverage was added.

---

## Verified Good Patterns

1. **Sidecar binary naming**: `binaries/eidolon-cli-aarch64-apple-darwin` matches Tauri's platform-specific sidecar naming convention. `app.shell().sidecar("eidolon-cli")` resolves correctly because Tauri appends the target triple automatically.

2. **GatewayChannel wiring order**: Step 19 creates `GatewayServer`, step 19-gw-channel creates `GatewayChannel` and calls `setServer()` + `messageRouter.registerChannel()`. The order is correct -- the server exists before the channel is wired.

3. **Config path consistency (macOS/Linux)**: Both Rust (`get_config_path_internal`) and TypeScript (`getConfigPath`) resolve to `~/Library/Preferences/eidolon/eidolon.json` on macOS and `~/.config/eidolon/eidolon.json` on Linux. The paths are consistent.

4. **OutboundMessage flow end-to-end**: `chat.send` RPC -> EventBus `user:message` (with `userId: clientId`) -> cognitive loop -> `routeOutbound({channelId: "gateway", userId})` -> `GatewayChannel.send()` -> `sendTo(userId, pushEvent)` -> client receives `push.chatMessage`. The full chain passes `userId` correctly.

5. **Push event registration**: `setupChatPushHandlers` is called in `App.svelte` both on initial connect and via `onNewClient` callback. The unsubscribe pattern correctly cleans up old handlers before registering new ones.

6. **Message size limits**: Frontend enforces 50KB (`MAX_MESSAGE_LENGTH`), backend enforces 100KB via Zod schema (`z.string().max(100_000)`). The frontend limit is stricter, which is correct.

---

## Summary

| Severity | Count | New vs Prior |
|----------|-------|-------------|
| Critical | 0 | -- |
| High | 3 | All new |
| Medium | 7 | All new |
| Low | 8 | All new |

**Key themes this round:**
- Cross-platform edge cases (CSP, Claude config path, terminal opening, nvm glob, Windows paths)
- Chat store race conditions in rapid-send and fast-response scenarios
- Dead code (`push.taskCompleted` handler)
- Duplicate class definitions causing `instanceof` failures

**Most impactful issue**: H-2 (CSP blocks remote WebSocket connections) completely breaks the multi-device client scenario, which is a primary use case.
