# Eidolon Desktop App Audit -- Round 1

**Date**: 2026-03-08
**Scope**: Tauri backend (`apps/desktop/src-tauri/`), Svelte frontend (`apps/desktop/src/`), Core gateway (`packages/core/src/gateway/`), Protocol types (`packages/protocol/`)

---

## Compilation Status

| Check | Result |
|-------|--------|
| TypeScript (`pnpm -r typecheck`) | 0 errors, 0 warnings |
| Rust (`cargo check`) | 0 errors, 1 warning (deprecated `Shell::open`) |
| Test suite (`pnpm -r test`) | 2940 pass, 6 skip, **1 fail** |

---

## CRITICAL Issues

### C-1. `setupChatPushHandlers()` is NEVER called -- chat responses never appear

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (line 132)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/App.svelte` (no call site)

**What is wrong**: The function `setupChatPushHandlers(client)` registers handlers for `push.taskCompleted` and `push.chatMessage` push events. These are the ONLY mechanisms by which the server's AI response reaches the frontend. However, this function is never called anywhere in the application. It is exported but never imported or invoked.

**Impact**: After the user sends a chat message, the "Thinking..." placeholder will NEVER be replaced with the actual AI response. The chat feature is fundamentally broken.

**Fix**: Call `setupChatPushHandlers(client)` after the WebSocket connection is established and authenticated. The natural place is in `App.svelte` after `connect()` succeeds, or in the connection store's `createClient` function. The returned unsubscribe function must be stored and called on disconnect. Example:

```typescript
// In connection.ts createClient(), or in App.svelte after connect():
client.onStateChange((state) => {
  if (state === "connected") {
    unsubChat = setupChatPushHandlers(client);
  }
});
```

---

### C-2. `memory.search` response shape mismatch -- memory browser shows wrong/missing fields

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/memory.ts` (line 44)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/rpc-handlers-chat.ts` (lines 143-160)

**What is wrong**: The frontend expects `memory.search` to return `{ results: MemoryItem[] }` where `MemoryItem` has fields: `id`, `type`, `content`, `importance`, `createdAt`, `metadata`. The backend returns results with these fields: `id`, `type`, `layer`, `content`, `confidence`, `score`, `bm25Score`, `vectorScore`, `graphScore`, `matchReason`, `tags`, `createdAt`, `updatedAt`. Key mismatches:

1. Frontend expects `importance` -- backend returns `confidence` (at `r.memory.confidence`) and `score` (the search relevance score). These are different concepts.
2. Frontend expects `metadata` -- backend does not return a `metadata` field.
3. Frontend expects 5-value `type` enum (`episodic | semantic | procedural | working | meta`) but backend `MemoryType` may have a different set.

**Impact**: Memory search results will display but with `importance: undefined` (renders as "NaN%" in the UI) and missing metadata. The `typeLabel()` and `typeColor()` functions may hit the fallback case for unrecognized types.

**Fix**: Either map the backend's `confidence` field to `importance` in the store, or update the `MemoryItem` interface to match the backend's response shape.

---

### C-3. `system.status` response lacks `cognitiveState`, `energy`, `serverVersion`, `connectedSince` -- dashboard shows stale defaults

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/dashboard.ts` (line 94, `parseStatus`)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/builtin-handlers.ts` (line 99, `system.status` handler)

**What is wrong**: The dashboard's `parseStatus()` expects fields: `cognitiveState`, `energy.current`, `energy.max`, `activeTasks`, `memoryCount`, `uptime`, `connectedClients`, `serverVersion`, `connectedSince`, `latencyMs`. The backend's `system.status` handler returns: `state`, `energy` (hardcoded `{ current: 0, max: 100 }`), `activeTasks` (hardcoded `0`), `memoryCount`, `uptime`, `connectedClients` (count only). Missing:

1. `cognitiveState` -- backend returns `state: "running"` (not a PEAR state). The frontend reads `raw.cognitiveState` which is `undefined`, so it falls back to `"idle"` permanently.
2. `serverVersion` -- not returned by the handler. Dashboard always shows "unknown".
3. `connectedSince` -- not returned. Dashboard always shows "--".
4. `connectedClients` -- backend returns a number, frontend expects `Array<{ id, platform }>`. The clients card will show "0" even when clients are connected because `Array.isArray(number)` is `false`.
5. `energy` -- hardcoded to `{ current: 0, max: 100 }`, energy bar always shows empty.

**Impact**: The dashboard is mostly decorative -- all status cards show default/zero values. The cognitive state dot never changes from "Idle".

**Fix**: The `system.status` builtin handler needs to be enriched to return actual cognitive loop state, energy budget, connected client details, and server version. Alternatively, the core RPC handler version (in `rpc-handlers-session.ts`) which returns `memoryCount` and `eventQueueDepth` could be used/merged, but it also lacks the required fields.

---

## HIGH Issues

### H-1. `discover_servers` Tauri invoke parameter mismatch in `discovery.ts`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/discovery.ts` (line 214)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 61)

**What is wrong**: The `discovery.ts` file calls `invoke("discover_servers", { port: DISCOVERY_PORT, timeoutMs })`. The Rust command signature is `pub async fn discover_servers(timeout_ms: u64)` -- it takes a single parameter `timeout_ms` (snake_case). Tauri auto-converts camelCase to snake_case for the args object, so `{ timeoutMs }` maps to `timeout_ms` correctly. However, `discovery.ts` passes an extra parameter `port` that the Rust function does not accept. Tauri ignores extra parameters, so this does not crash, but it is misleading.

The more important issue is that `discovery.ts` returns the raw Rust `DiscoveredServer` objects and tries to parse them as `BeaconPayload` via `extractBeacon()`. The Rust struct has fields `service`, `version`, `host`, `port`, `hostname`, `name`, `tailscale_ip`, `tls` (with `tailscale_ip` serialized as `tailscaleIp` via `#[serde(rename)]`). The `isValidBeacon()` function requires `role === "server"` and `startedAt` (a number), which the Rust struct does NOT include. So `extractBeacon()` always returns `null`, and UDP discovery via the Tauri backend always returns an empty array.

**Impact**: The `discoverServers()` function in `discovery.ts` will never return servers from UDP discovery. Only the HTTP fallback probe works. However, `ClientSetup.svelte` and `Settings.svelte` call the Rust command directly (bypassing `discovery.ts`), so their discovery works correctly.

**Fix**: Either update `discovery.ts` to handle the Rust response shape directly (without `isValidBeacon`), or update the Rust `DiscoveredServer` struct to include `role` and `startedAt` fields.

---

### H-2. Token lost on app restart (sessionStorage) -- users must re-enter token every launch

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/settings.ts` (lines 70-77, 93-102)

**What is wrong**: The auth token is stored in `sessionStorage`, which is explicitly documented as being "cleared on window close" for security. However, Tauri's `on_window_event` handler intercepts `CloseRequested` and hides the window instead of closing it (`api.prevent_close()`). This means `sessionStorage` persists while the app is "hidden" but is lost if the app actually quits (via tray "Quit" or system restart).

For the **server role**, `autoConnect()` in `App.svelte` reads the token from `get_server_gateway_config` (reading the config file) and passes it to `updateSettings`, so the token is re-populated from the config file on each startup. This works.

For the **client role**, `autoConnect()` reads from `get_client_config` which reads the saved config's `server.token` field. This also re-populates the token.

**Verdict**: After closer analysis, this is actually handled correctly because `autoConnect()` re-reads from config files on startup. However, if the user manually changes the token in Settings (without also changing the config file), the new token is lost on restart. This is a minor UX issue rather than a blocker. Downgraded from HIGH to MEDIUM.

---

### H-3. `push.taskCompleted` is never emitted by the backend

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/chat.ts` (line 133)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/` (no matching push emitter)

**What is wrong**: The chat store subscribes to `push.taskCompleted` as a secondary mechanism for receiving AI responses. A grep across the entire `packages/core/src/gateway/` directory finds zero occurrences of `push.taskCompleted` being emitted. The only chat response mechanism is `push.chatMessage` from `GatewayChannel.send()`. Since `setupChatPushHandlers` is never called anyway (C-1), this is academic -- but once C-1 is fixed, the `push.taskCompleted` handler will be dead code.

**Impact**: Dead code that could confuse maintainers. The `push.chatMessage` handler is the correct one.

**Fix**: After fixing C-1, either remove the `push.taskCompleted` handler or ensure the cognitive loop emits it when tasks complete.

---

### H-4. `system.subscribe` push events may never reach the client

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/dashboard.ts` (lines 187, 191)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/builtin-handlers.ts` (line 112)

**What is wrong**: The dashboard calls `client.call("system.subscribe")` and then listens for `system.statusUpdate` push events via `client.onPush()`. The `system.subscribe` handler adds the client as a subscriber. The `broadcastStatus()` method in `client-manager.ts` broadcasts to subscribers. However, `broadcastStatus()` must be called periodically by the cognitive loop or some other component. If no component calls `server.broadcastStatus()`, subscribers never receive updates, and the dashboard relies entirely on its 5-second polling.

**Impact**: The push subscription is likely a no-op unless the daemon's main loop explicitly calls `broadcastStatus()`. The dashboard still works via polling but misses real-time updates.

**Fix**: Ensure the cognitive loop or daemon periodically calls `gateway.broadcastStatus()` with the current system state.

---

## MEDIUM Issues

### M-1. Memory search results use `confidence` but frontend expects `importance`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/memory.ts` (line 15, `MemoryItem.importance`)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/rpc-handlers-chat.ts` (line 149, returns `confidence`)

**What is wrong**: The backend returns `confidence` (a 0-1 float from the memory record) but the frontend reads `importance` which will be `undefined`. The importance bar renders as "NaN%".

**Fix**: Map `confidence` to `importance` in the response, or rename the frontend field.

---

### M-2. Tauri `discover_servers` returns flat objects but `discovery.ts` expects beacon-shaped objects

Covered in H-1. Settings page and ClientSetup bypass this issue by invoking the Rust command directly and using the raw result shape.

---

### M-3. `learning.list` frontend assumes `status: "pending"` but backend uses `"new"` and `"evaluated"`

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/learning.ts` (lines 62-64)
- `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/rpc-handlers-session.ts` (lines 217-218)

**What is wrong**: The frontend's `LearningItem.status` type is `"pending" | "approved" | "rejected"`. Items with unknown status fall back to `"pending"`. The backend stores items with status `"new"` or `"evaluated"` (see `learning.approve` handler validation at line 217). The frontend will show all `"new"` and `"evaluated"` items as `"pending"`, which is acceptable behavior, but `learning.approve` only accepts items with status `"new"` or `"evaluated"`. If the frontend approves a `"pending"` (which is actually `"new"`), it will work. But if it tries to approve an already-`"approved"` item, the backend will reject it with an error.

**Impact**: Items that are `"new"` or `"evaluated"` will all display as "pending" -- functionally correct but semantically imprecise. The approve/reject actions work correctly.

---

### M-4. `setup_claude_token` is macOS-only (uses AppleScript/Terminal)

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (lines 430-438)

**What is wrong**: The `setup_claude_token` command uses `osascript` to open Terminal.app, which is macOS-specific. On Linux and Windows, this will fail with "Failed to open Terminal".

**Impact**: Server onboarding with OAuth will fail on Linux and Windows.

**Fix**: Add platform-specific terminal launching: `gnome-terminal`, `xterm`, or `cmd.exe /c start`.

---

### M-5. Token persisted in sessionStorage survives window hide but lost on quit

Downgraded from H-2. The `autoConnect()` function re-reads credentials from config files on startup, so this is only an issue for manually-entered settings that differ from the config file.

---

### M-6. `onboard_setup_server` returns a JSON string, not a JSON object

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 972, `Ok(result.to_string())`)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/onboarding/ServerSetup.svelte` (lines 101-103)

**What is wrong**: The Rust command returns `Ok(result.to_string())` which serializes the JSON value to a string. Tauri then wraps this in a JSON-RPC response, so the frontend receives a double-encoded JSON string. The frontend handles this by checking `typeof rawResult === "string"` and calling `JSON.parse(rawResult)`. This works but is fragile and non-standard.

**Fix**: Return `Ok(result)` as a `serde_json::Value` instead of `Ok(result.to_string())`. This requires changing the return type from `Result<String, String>` to `Result<serde_json::Value, String>`.

---

### M-7. Dashboard `connectedClients` expects an array but backend returns a number

Covered in C-3. The clients card will always show 0.

---

## LOW Issues

### L-1. Deprecated Tauri API: `tauri_plugin_shell::Shell::open`

**File**: `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 54)

**What is wrong**: `cargo check` warns that `Shell::open` is deprecated in favor of `tauri-plugin-opener`.

**Fix**: Replace with `tauri_plugin_opener` plugin.

---

### L-2. One failing test: `buildClaudeArgs > basic prompt produces correct base args`

**File**: `/Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/__tests__/args.test.ts`

**What is wrong**: The test for `buildClaudeArgs` fails. This is in the core package, not the desktop app, but indicates a regression in Claude CLI argument generation.

**Fix**: Investigate and fix the failing test.

---

### L-3. `nvm` glob path in `find_claude_binary()` does not work

**File**: `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 312)

**What is wrong**: The candidate path `~/.nvm/versions/node/*/bin/claude` contains a glob `*` but `std::path::Path::new(path).exists()` does not expand globs. The comment acknowledges this: "won't work with glob but fallback". The `which claude` fallback at line 320 handles this case.

**Impact**: Negligible -- the `which` fallback works.

---

### L-4. `rand::thread_rng()` is deprecated in rand 0.9+

**File**: `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (line 833)

**What is wrong**: `rand::thread_rng()` was deprecated in rand 0.9 in favor of `rand::rng()`. This does not currently cause a compilation error (may be on rand 0.8) but will when upgrading.

---

### L-5. `discovery.ts` passes unused `port` parameter to Tauri invoke

**File**: `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/discovery.ts` (line 214)

**What is wrong**: Passes `{ port: DISCOVERY_PORT, timeoutMs }` but the Rust command only accepts `timeout_ms`. The `port` parameter is silently ignored.

**Fix**: Remove the `port` parameter from the invoke call.

---

### L-6. `editMemory()` is a no-op but the UI exposes Edit button

**Files**:
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/lib/stores/memory.ts` (line 103)
- `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/memory/+page.svelte` (line 240)

**What is wrong**: The memory detail panel has an "Edit" button that calls `editMemory()`, which logs a warning and returns `false`. The user sees "Editing memories is not yet supported by the backend" in the error banner, which is confusing.

**Fix**: Either hide the Edit button or implement the `memory.update` RPC handler.

---

### L-7. Updater pubkey placeholder in tauri.conf.json

**File**: `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/lib.rs` (comment at lines 7-12)

**What is wrong**: The comment warns that the updater pubkey in `tauri.conf.json` must be replaced with a real Ed25519 key before production. An empty or placeholder pubkey disables update signature verification.

**Impact**: Security risk for production releases. Not an issue for development.

---

### L-8. Navigation uses emoji characters in sidebar

**File**: `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src/routes/+layout.svelte` (lines 25-29)

**What is wrong**: Navigation icons use raw Unicode characters/emoji (`\u{25A6}`, `\u{1F4AC}`, etc.). These may render inconsistently across platforms.

**Impact**: Cosmetic.

---

### L-9. `HOME` env var may be empty on Windows

**File**: `/Users/manuelguttmann/Projekte/eidolon/apps/desktop/src-tauri/src/commands.rs` (multiple locations)

**What is wrong**: Multiple functions use `std::env::var("HOME").unwrap_or_default()`. On Windows, `HOME` is not always set. The code handles this by falling back to `APPDATA` for Windows-specific paths via `cfg!(target_os = "windows")` blocks, so the critical paths are covered. However, `find_claude_binary()` at line 306 uses `HOME` unconditionally for candidate paths, which would produce invalid paths on Windows if `HOME` is not set.

**Impact**: Low -- Windows users may not find Claude CLI via the candidate list, but `which` fallback handles it (though `which` is also Unix-specific; `where.exe` is the Windows equivalent).

---

## Summary

| Severity | Count | Key Issues |
|----------|-------|------------|
| CRITICAL | 3 | Chat push handlers never wired up; memory field mismatch; dashboard status mismatch |
| HIGH | 4 | Discovery shape mismatch; taskCompleted never emitted; subscribe no-op; token UX |
| MEDIUM | 7 | Confidence vs importance; learning status naming; macOS-only OAuth; double-encoded JSON; etc. |
| LOW | 9 | Deprecated APIs; failing test; no-op edit; placeholder pubkey; etc. |

**Most impactful fix**: Wiring `setupChatPushHandlers()` (C-1) will make the chat feature work end-to-end. This is a one-line fix with the highest return on effort.

**Second most impactful**: Enriching the `system.status` response (C-3) will bring the dashboard to life.

**Third**: Mapping `confidence` to `importance` (M-1 / C-2) will fix the memory browser display.
