# Eidolon Desktop App Audit -- Round 3

**Date**: 2026-03-08
**Scope**: Deep dive into daemon sidecar lifecycle, gateway initialization order, event bus retry semantics, Claude stream parsing, settings page, security (XSS/CSP), error recovery, and Tauri invoke cross-checks. Focuses on areas Rounds 1-2 did not deeply examine.
**Prior rounds**: Round 1 found 23 issues, Round 2 found 15 issues. All critical/high fixes from earlier rounds are confirmed applied.

---

## Compilation Status

| Check | Result |
|-------|--------|
| TypeScript (`pnpm -r typecheck`) | 0 errors, 0 warnings |
| Rust (`cargo check`) | 0 errors, 1 warning (same deprecated `Shell::open` from Rounds 1-2) |
| Test suite (`pnpm -r test`) | 3112 pass, 6 skip, **0 fail** |

---

## HIGH Issues

### H-1. Response broadcast to ALL clients instead of targeted delivery -- multi-client message leakage

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/gateway-channel.ts` (lines 43-71)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/daemon/event-handlers-user.ts` (lines 195-201)
- `/Users/manuelguttmann/Projekte/eidolon/packages/protocol/src/types/messages.ts` (lines 24-31)

**What is wrong**: When the cognitive loop processes a `user:message` event and generates a response, it calls `messageRouter.routeOutbound()` with an `OutboundMessage` containing `id`, `channelId`, `text`, `format`, and `replyToId`. The `OutboundMessage` interface does NOT have a `userId` field.

The `GatewayChannel.send()` method at line 63 attempts to extract a `userId` via an unsafe cast: `(message as unknown as Record<string, unknown>).userId as string | undefined`. Since the outbound message never carries `userId`, `targetClientId` is always `undefined`. The code falls through to line 67: `this.server.broadcast(pushEvent)` -- which sends the response to ALL connected, authenticated clients.

This means: if two desktop clients (Client A and Client B) are connected simultaneously, and Client A sends a message, the AI response will be broadcast to BOTH Client A and Client B. Client B sees a response they did not request.

**Impact**: Privacy violation in multi-client scenarios. Every connected client sees every AI response, regardless of who asked the question. This is particularly problematic when clients are on different devices belonging to different people (e.g., the owner and a family member using a shared server).

**Fix**: The event handler in `event-handlers-user.ts` must pass the `userId` through the outbound message. Either:
1. Extend `OutboundMessage` with an optional `userId?: string` field, or
2. Store the `userId` from the event payload alongside `channelId` and pass it through (the payload at line 28-29 already extracts `userId`).

The `GatewayChannel.send()` targeting logic (lines 63-68) is already correct -- it just never receives a `userId` to target.

---

### H-2. Daemon sidecar crash is reported but never auto-restarted

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 228-263, daemon monitor task)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/App.svelte` (lines 130-134, daemon-exit listener)

**What is wrong**: When the daemon sidecar process exits (crash, signal, etc.), the Tauri backend:
1. Emits a `daemon-exit` event with the exit code (line 251)
2. Clears the `DaemonState` so `daemon_running()` returns false (lines 253-256)

The frontend receives this event and sets `daemonError` to display a banner (line 132). However, **no restart is attempted**. The user sees "Daemon exited unexpectedly" but must manually navigate to Settings, then... there is no "Restart Daemon" button in the Settings page. The only way to restart the daemon is to quit and relaunch the entire application.

For the server role, a daemon crash means the entire brain stops. No messages are processed, no channels work. The user has no way to recover without restarting the app.

**Impact**: A single daemon crash renders the entire application non-functional until manual restart. For an autonomous AI assistant that is supposed to run continuously (especially on headless servers), this is a critical reliability gap.

**Fix**: Add auto-restart logic in the `daemon-exit` event handler:
1. On unexpected exit (non-zero code or signal), wait 2-3 seconds, then call `start_daemon` again
2. Limit restart attempts (e.g., max 3 within 5 minutes) to prevent crash loops
3. Add a "Restart Daemon" button in the error banner UI

---

### H-3. `connect-src *` in CSP allows WebSocket/fetch to any origin

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/tauri.conf.json` (line 25)

**What is wrong**: The Content Security Policy is:
```
default-src 'self'; script-src 'self'; connect-src *; style-src 'self' 'unsafe-inline'
```

The `connect-src *` directive allows the frontend JavaScript to make WebSocket connections and HTTP requests to any host. This is necessary because the gateway server can be on any IP/port (localhost, LAN, Tailscale). However, it means that if an XSS vulnerability is ever introduced (e.g., someone changes `{msg.content}` to `{@html msg.content}` without DOMPurify), malicious scripts could exfiltrate data to any external server.

Currently there is no XSS vulnerability (the code correctly uses text interpolation, not `{@html}`, and has comments warning against changing this). But the CSP provides no defense-in-depth.

**Impact**: No immediate exploit, but eliminates the CSP safety net that would contain a future XSS vulnerability. The auth token stored in sessionStorage would be exfiltrable.

**Fix**: If the gateway host/port is known after connection, dynamically narrow `connect-src` via a Tauri command. Alternatively, accept this as a known trade-off for the desktop app (which has fewer XSS vectors than a web app) but document it explicitly.

---

## MEDIUM Issues

### M-1. Failed handler events are retried up to 10 times, potentially spawning 10 Claude CLI sessions for one message

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/loop/cognitive-loop.ts` (lines 312-316)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/loop/event-bus.ts` (lines 222-244)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/loop/event-utils.ts` (line 85, `MAX_RETRIES = 10`)

**What is wrong**: When a handler fails (returns `success: false` or throws), the cognitive loop calls `eventBus.defer(event.id)`, which increments `retry_count` and unclaims the event. On the next cycle, the event is dequeued again and reprocessed. This continues up to `MAX_RETRIES = 10` times before the event is dead-lettered.

For `user:message` events, each retry spawns a new Claude CLI subprocess, prepares a new workspace, generates a new MEMORY.md, and waits for the full response. If Claude is failing due to a transient issue (rate limit, network), this creates 10 full Claude sessions for a single user message. Each session has a configurable timeout (`brain.session.timeoutMs`), so this could block the loop for 10x the timeout.

Furthermore, the user receives no feedback during retries. The "Thinking..." placeholder persists. If all 10 retries fail, the event is dead-lettered with only a log message -- no response ever reaches the user.

**Impact**: Resource waste and potential API cost amplification. A single failing message could trigger 10 Claude API calls. The user is left with a permanent "Thinking..." state.

**Fix**:
1. Add a `maxRetries` override per event type. `user:message` should retry at most 1-2 times.
2. On final failure (dead letter), send an error message back to the channel: "Sorry, I was unable to process your message after multiple attempts."
3. Add exponential backoff between retries for the same event.

---

### M-2. `EIDOLON_MASTER_KEY` is passed to the sidecar via environment variable, visible in `/proc/PID/environ`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 203-207, 215-217)

**What is wrong**: The `start_daemon` command reads the master key from disk (`read_master_key()`) and passes it to the sidecar process via the `EIDOLON_MASTER_KEY` environment variable. On Linux, any user with access to `/proc/<daemon_pid>/environ` can read all environment variables of the process, including the master key.

On macOS, this is less of a concern (process environment is only readable by the same user). On Linux servers (which is the primary target for the "brain" deployment), another process running as the same user can trivially read the master key.

The master key is used for AES-256-GCM encryption of all secrets (API keys, channel tokens). Compromising it means all secrets are decryptable.

**Impact**: On shared Linux systems, the master key is exposed via the process environment. Single-user desktop systems are not affected.

**Fix**: Instead of passing the key via environment, have the daemon read it from the key file directly. The daemon already has access to the config path. Alternatively, pass the key via stdin (pipe) which is not visible in `/proc/PID/environ`.

---

### M-3. `stop_daemon` sends SIGTERM but does not verify process actually exits

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 268-289)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/lib.rs` (lines 18-36, `graceful_stop_daemon`)

**What is wrong**: Both `stop_daemon` and `graceful_stop_daemon` send SIGTERM to the daemon process and immediately return. Neither waits for the process to actually exit. The `graceful_stop_daemon` (called from tray quit) does `std::thread::sleep(500ms)` after SIGTERM, but:
1. 500ms may not be enough for the daemon to flush SQLite WAL, disconnect channels, and stop the cognitive loop (the daemon shutdown has a configurable grace period, typically seconds).
2. After the 500ms sleep, `app.exit(0)` is called regardless -- if the daemon hasn't exited, it becomes an orphan process.

The monitor task (spawned in `start_daemon`) does handle the `Terminated` event and clears the state, but this is asynchronous and may not complete before `app.exit(0)`.

**Impact**: On quit, the daemon may be killed mid-operation:
- SQLite WAL may not be checkpointed, risking data loss on next startup
- Active Claude sessions may leave orphaned processes
- Channels (Telegram, Discord) may not cleanly disconnect

**Fix**: In `graceful_stop_daemon`, after sending SIGTERM, poll `daemon_running()` (or wait on the process) with a longer timeout (5 seconds). Only call `app.exit(0)` after confirming the daemon has exited, or after the timeout.

---

### M-4. Claude parser silently drops `tool_result` events without extracting text content

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/parser.ts` (lines 57-62)

**What is wrong**: When Claude Code CLI emits a `type: "result"` event with a `tool_use_id` field, the parser returns `{ type: "tool_result", toolResult: parsed.result, timestamp: now }`. The `ClaudeCodeManager.run()` in `manager.ts` (lines 155-174) only collects text from `case "text"` events -- `tool_result` events are silently ignored (they fall through to `default: break`).

This means that any output produced by tool use (e.g., file reads, shell commands, web searches) is lost from the response. Only the assistant's direct text blocks are captured. If Claude's entire response comes through tool use results (which can happen with structured output), the response will be empty, triggering the empty-response handling.

**Impact**: Responses that rely heavily on tool use may be truncated or empty. The parser correctly identifies the events, but the handler ignores them.

**Fix**: In the `handleUserMessage` event handler's stream processing loop, handle `tool_result` events:
```typescript
case "tool_result": {
  // Tool results may contain text that should be part of the response
  if (typeof streamEvent.toolResult === "string") {
    responseChunks.push(streamEvent.toolResult);
  }
  break;
}
```

---

### M-5. Settings page "Save" only writes to sessionStorage/localStorage, not to the config file

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/settings/+page.svelte` (lines 62-68)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/settings.ts` (lines 82-103)

**What is wrong**: The Settings page has three buttons: Save, Connect, and Reset. "Save" calls `updateSettings()` which writes to sessionStorage (token) and localStorage (host/port/tls). "Connect" calls `handleSave()` then `connect()`.

However, none of these write back to the config file (`eidolon.json`). The Tauri backend has `save_client_config` for writing client configs, but the Settings page never calls it. This means:
1. If the user changes connection settings in Settings and clicks Save, the changes persist in browser storage but NOT in the config file
2. On next app launch, `autoConnect()` reads from the config file (`get_client_config` / `get_server_gateway_config`), overwriting the user's saved settings
3. For the server role, changing the port in Settings has no effect on the actual gateway server (which reads from the config file at daemon startup)

**Impact**: Settings changes are ephemeral -- they survive within a session but are lost on app restart. The user may think they saved their settings permanently but they revert on relaunch.

**Fix**: When the user clicks "Save" with changes to host/port/token/tls, call `invoke("save_client_config", { host, port, token, tls })` to persist to the config file. For server role, warn that port changes require a daemon restart.

---

### M-6. Event bus `anticipation:check` and `anticipation:suggestion` not in `VALID_EVENT_TYPES`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/loop/event-utils.ts` (lines 30-80)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/daemon/event-handlers.ts` (lines 68-73)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/daemon/init-loop.ts` (lines 314, `action: "anticipation:check"`)

**What is wrong**: The cognitive loop event handler routes `anticipation:check` and `anticipation:suggestion` events (lines 68-73 of `event-handlers.ts`). The scheduler creates tasks with `action: "anticipation:check"` (line 314 of `init-loop.ts`). However, neither `"anticipation:check"` nor `"anticipation:suggestion"` appear in the `VALID_EVENT_TYPES` set in `event-utils.ts`.

The `rowToEvent()` function at line 149 validates event types: if the type is not in `VALID_EVENT_TYPES`, it falls back to `"system:health_check"`. This means anticipation events stored in SQLite will be deserialized as `system:health_check` on replay/dequeue, and the cognitive loop handler will route them to the `default` case (no-op) instead of the anticipation handlers.

Similarly missing from `VALID_EVENT_TYPES`: `"workflow:trigger"`, `"workflow:step_ready"` (handled at lines 74-81 of `event-handlers.ts`).

**Impact**: Anticipation and workflow events work correctly in-memory (publish -> dequeue within the same process lifetime) but will be silently mistyped if the daemon restarts and replays unprocessed events from SQLite. The anticipation system effectively loses all pending checks on daemon restart.

**Fix**: Add to `VALID_EVENT_TYPES`:
```typescript
"anticipation:check",
"anticipation:suggestion",
"workflow:trigger",
"workflow:step_ready",
```

---

### M-7. No error handling when `daemon_running()` mutex is poisoned

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 291-297)

**What is wrong**: The `daemon_running` command uses `unwrap_or_else(|e| e.into_inner())` to recover from a poisoned mutex. This is intentional (the comment explains it). However, `start_daemon` at line 188 uses `state.0.lock().map_err(|e| e.to_string())?` which returns an error string to the frontend if the mutex is poisoned. If a previous `start_daemon` call panicked while holding the lock, the mutex is permanently poisoned, and ALL subsequent `start_daemon` calls will fail with a confusing "PoisonError" message.

This is a known Rust pattern issue. The `daemon_running` function handles it gracefully, but `start_daemon` and `stop_daemon` do not.

**Impact**: If a panic occurs during daemon startup (e.g., sidecar spawn failure that triggers unwrap), the mutex becomes permanently poisoned and the daemon can never be started again without restarting the entire Tauri app.

**Fix**: Use `.unwrap_or_else(|e| e.into_inner())` consistently in `start_daemon` and `stop_daemon`, matching the pattern in `daemon_running`.

---

## LOW Issues

### L-1. `save_client_config` does not validate host/port inputs

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 712-756)

**What is wrong**: The `save_client_config` command accepts `host: String, port: u16, token: String, tls: bool` and writes them directly into the config file. While the Rust type system ensures `port` is a valid `u16`, the `host` and `token` strings are not validated. A malicious or buggy frontend could write arbitrary content into the config file's `server.host` field (e.g., a host containing shell metacharacters or newlines).

**Impact**: Low -- the host string is only used for WebSocket connections (not shell commands), and the frontend validates hostname format in `settings.ts` (line 112, `HOSTNAME_RE`). But defense in depth suggests validating on the Rust side too.

---

### L-2. `updateSettingsStore` lacks `$updateSettingsStore` export alias

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/settings/+page.svelte` (lines 8-15)

**What is wrong**: The Settings page imports `updateSettingsStore` from the settings store and accesses it via `$updateSettingsStore` (Svelte auto-subscribe). However, the import also pulls in `updateSettings` (a function) and `settingsStore` (a writable). In Svelte 5 with runes, the `$` prefix auto-subscribes to stores in `.svelte` files. This works correctly. Not a bug, just noting that the naming (`updateSettings` function vs `updateSettingsStore` store) is confusing.

**Impact**: None -- code works correctly. Naming clarity could be improved.

---

### L-3. `isStreaming` store is not reset when the WebSocket disconnects

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (line 23)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/connection.ts` (lines 25-32)

**What is wrong**: If the user sends a message and the WebSocket disconnects before the `push.chatMessage` response arrives, the `streamingStore` remains `true`. The "Thinking..." placeholder persists permanently. The connection state changes to "error" or "disconnected", but `streamingStore` is never cleared.

**Impact**: The send button stays disabled, and the "Thinking..." placeholder remains after disconnect. The user must clear the chat to recover.

**Fix**: In the connection store's `onStateChange` handler, when state becomes `"disconnected"` or `"error"`, set `streamingStore.set(false)`. Alternatively, add a timeout (e.g., 2 minutes) that auto-clears the streaming state.

---

### L-4. `handleSend` in chat page calls `scrollToBottom()` before the async `sendMessage` completes

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/chat/+page.svelte` (lines 25-36)

**What is wrong**: The `handleSend` function awaits `sendMessage(content)` and then calls `scrollToBottom()`. But `sendMessage` adds the user message and "Thinking..." placeholder to the store synchronously (before the `await client.call`), so the DOM updates happen before `scrollToBottom()` is called. The `$effect` on line 53 also triggers `scrollToBottom()` when `$messages` changes.

This is actually fine -- the `$effect` handles it. The explicit `scrollToBottom()` call after `sendMessage` is redundant but harmless. Not a bug, just unnecessary code.

**Impact**: None.

---

### L-5. Master key generation uses `rand::thread_rng()` which is deprecated in rand 0.9+

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 845)

**What is wrong**: Same as Round 1 L-4. The `random_hex` function uses `rand::thread_rng()`. This generates cryptographically strong randomness via `rand 0.8` (which delegates to the OS CSPRNG), but `thread_rng()` is deprecated in `rand 0.9`. Since this generates master keys and auth tokens, the quality of randomness is critical and currently adequate.

**Impact**: None currently. Will need updating when upgrading to rand 0.9.

---

### L-6. Claude parser maps unknown event types to system messages, polluting the response

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/parser.ts` (lines 76-77)

**What is wrong**: When the parser encounters an unrecognized JSON event type, it returns `{ type: "system", content: JSON.stringify(parsed) }`. In the `ClaudeCodeManager.run()` handler, `system` events are not handled (fall through to `default: break`), so they are silently dropped. This is correct behavior.

However, if a future handler tries to process `system` events (e.g., for progress tracking), the entire raw JSON of unrecognized events would be treated as system content. This is a minor robustness concern.

**Impact**: None currently. The fallback is conservative and correctly ignored.

---

### L-7. `onNewClient` callback array in connection store is never cleaned up

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/connection.ts` (lines 15-20)

**What is wrong**: `onNewClient()` pushes callbacks into a module-level array but never provides a way to remove them. The callback from `App.svelte` line 118 is registered once on module load. Since the app is a single-page application and the module is loaded once, this is not a memory leak. But if `onNewClient` were called conditionally in a component lifecycle, the callbacks would accumulate.

**Impact**: Negligible in the current codebase. Minor code hygiene issue.

---

### L-8. `open_external_url` does not sanitize URL beyond scheme check

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 46-56)

**What is wrong**: The URL validation only checks that the scheme is `http://` or `https://`. It does not validate the rest of the URL. While `Shell::open` delegates to the OS browser, crafted URLs could potentially exploit browser-specific vulnerabilities or phishing (e.g., `https://evil.com` with homograph characters).

**Impact**: Very low. Standard desktop app behavior. The user's browser provides its own protections.

---

## Tauri Invoke Cross-Check

All `invoke()` calls in the Svelte frontend were verified against the registered commands:

| Frontend `invoke()` Call | Rust Command | Params Match | Return Type Match |
|---|---|---|---|
| `check_config_exists()` | `check_config_exists` | no params / no params | `bool` / `bool` |
| `validate_config()` | `validate_config` | no params / no params | `{valid, issues}` / `serde_json::Value` |
| `get_config_role()` | `get_config_role` | no params / no params | `string` / `String` |
| `get_server_gateway_config()` | `get_server_gateway_config` | no params / no params | `{port, token, tls}` / `serde_json::Value` |
| `get_client_config()` | `get_client_config` | no params / no params | `{host, port, token?, tls?}` / `ClientConfig` |
| `get_config_path()` | `get_config_path` | no params / no params | `string` / `String` |
| `start_daemon({configPath})` | `start_daemon` | `{configPath}` / `config_path: String` | `number` (pid, discarded) / `u32` |
| `stop_daemon()` | `stop_daemon` | no params (uses State) | N/A (discarded) |
| `daemon_running()` | `daemon_running` | no params (uses State) | `bool` / `bool` |
| `discover_servers({timeoutMs})` | `discover_servers` | `{timeoutMs}` / `timeout_ms: u64` | `DiscoveredServer[]` / `Vec<DiscoveredServer>` |
| `setup_claude_token()` | `setup_claude_token` | no params / no params | `string` / `String` |
| `has_claude_token()` | `has_claude_token` | no params / no params | `bool` / `bool` |
| `onboard_setup_server({name, credentialType, apiKey})` | `onboard_setup_server` | match | `serde_json::Value` / `serde_json::Value` |
| `save_client_config({host, port, token, tls})` | `save_client_config` | match | void / `()` |
| `get_platform()` | `get_platform` | no params / no params | `{os, arch}` / `PlatformInfo` |
| `get_version()` | `get_version` | no params / no params | `string` / `String` |
| `open_external_url({url})` | `open_external_url` | match | void / `()` |
| `read_claude_token()` | `read_claude_token` | no params / no params | `string` / `String` |
| `get_os_username()` | `get_os_username` | no params / no params | `string` / `String` |

**Result**: All 19 invoke calls match their registered Rust commands in name, parameters, and return types. No mismatches found.

---

## Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| HIGH | 3 | Response broadcast to all clients (privacy); daemon crash never restarted; `connect-src *` CSP |
| MEDIUM | 7 | 10x Claude retry amplification; master key in env; stop_daemon no-wait; dropped tool_result; ephemeral settings; missing event types; mutex poisoning |
| LOW | 8 | No host validation; naming confusion; streaming not cleared on disconnect; deprecated rand API; etc. |

**No CRITICAL issues found.** All prior critical fixes remain in place.

---

## Most Impactful Fixes (Priority Order)

1. **H-1**: Pass `userId` through the outbound message so `GatewayChannel` can target the correct client instead of broadcasting. This is a privacy fix for multi-client scenarios and requires a small protocol extension.

2. **H-2**: Add daemon auto-restart logic on unexpected exit. This is essential for reliability in server deployments. The Tauri event infrastructure is already in place -- just add the restart logic.

3. **M-1 + M-6**: Limit retry count for user:message events and add missing event types to `VALID_EVENT_TYPES`. These prevent resource waste and ensure anticipation events survive daemon restarts.

4. **M-5**: Make Settings "Save" persist to the config file, not just browser storage. Without this, the Settings page gives a false sense of persistence.

5. **M-3**: Add a wait/verify step after SIGTERM in daemon shutdown to prevent data loss from premature exit.
