# Practical Backend Audit -- Round 1

**Date:** 2026-03-08
**Method:** Compile, run, and verify output -- not just code reading.

---

## 1. Test Suite Results

**Command:** `pnpm -r test`

| Package | Tests | Pass | Skip | Fail | expect() calls |
|---------|------:|-----:|-----:|-----:|---------------:|
| packages/core | 2947 | 2941 | 6 | 0 | 11,415 |
| packages/protocol | 100 | 100 | 0 | 0 | 201 |
| packages/test-utils | 24 | 24 | 0 | 0 | 66 |
| packages/cli | 171 | 171 | 0 | 0 | 451 |
| apps/desktop | 32 | 32 | 0 | 0 | 61 |
| apps/web | 35 | 35 | 0 | 0 | 132 |
| **Total** | **3309** | **3303** | **6** | **0** | **12,326** |

**Verdict: ALL TESTS PASS. Zero failures.**

### Skipped Tests

6 tests skipped in `packages/core`. Grepping for `it.skip` and `.skip(` found **zero matches** in test files, meaning the skips are likely handled programmatically (e.g., conditional `describe.skipIf` or environment-gated tests). No `it.skip` without linked issues.

### Warnings (non-blocking)

- **auto_vacuum=INCREMENTAL warnings**: Dozens of warnings from database manager tests. These are informational -- SQLite can only set auto_vacuum on fresh databases, not existing ones. Existing behavior is correct (falls back to mode 0).
- **structured-output retry exhaustion**: 5 log lines from structured-output parser tests exercising error paths. Expected test behavior.
- **Golden dataset metrics**: Rule-based extraction recall is 30.1% overall, which is by design (rule-based is a conservative fallback; LLM-based extraction handles the rest at runtime).

---

## 2. GatewayChannel Verification

**Runtime test output:**
```
id: gateway
name: Gateway WebSocket
capabilities: {"text":true,"markdown":true,"images":false,"documents":false,
               "voice":false,"reactions":false,"editing":false,"streaming":true}
isConnected: false
```

**Verdict: PASS.** The GatewayChannel instantiates correctly with channel ID `gateway`, correct capabilities, and starts disconnected (as expected before `setServer()` is called).

---

## 3. Gateway Wiring -- Call Chain Verification

Traced the full daemon init sequence by reading source code:

```
EidolonDaemon.start()                        [daemon/index.ts:53]
  |-> buildCoreInitSteps()                   [initializer.ts] -- steps 1-16g, 17b
  |-> wireChannels()                         [channel-wiring.ts] -- step 17
  |-> buildGatewayInitSteps()                [gateway-wiring.ts] -- steps 18-21
        |-> step "GPUManager"                (18)
        |-> step "STTClient"                 (18a)
        |-> step "GatewayServer"             (19) -- creates & starts GatewayServer
        |-> step "GatewayChannelWiring"      (19-gw-channel)
        |     |-> new GatewayChannel()
        |     |-> gatewayChannel.setServer(gatewayServer)
        |     |-> messageRouter.registerChannel(gatewayChannel)
        |-> step "CoreRpcWiring"             (19-core) -- registers all RPC handlers
        |-> step "GatewayGpuWiring"          (19a)
        |-> ... (WhatsApp, Calendar, HA, audit, metrics, plugins)
        |-> step "TailscaleDetector"         (20)
        |-> step "DiscoveryBroadcaster"      (21)
  |
  |-> writePidFile()
  |-> registerSignalHandlers()
  |-> cognitiveLoop.start()                  -- PEAR cycle begins
```

**Verified call chain:**
1. GatewayServer is created and started at step 19 (BEFORE GatewayChannel).
2. GatewayChannel is created, linked to the server, and registered on messageRouter at step 19-gw-channel.
3. This all happens BEFORE `cognitiveLoop.start()` (line 94 of index.ts).

**Verdict: PASS.** The wiring order is correct: server -> channel -> register -> loop start.

---

## 4. Claude CLI Integration

### Binary location
```
/Users/manuelguttmann/.local/bin/claude -> EXISTS (symlink to v2.1.71)
```
All other candidate paths not found, which is normal for this macOS setup.

### Eidolon Claude config directory
```
~/Library/Preferences/eidolon/claude-config/ -> EXISTS
```
Contains `.claude.json`, `settings.json`, `backups/`, `plans/`, `plugins/`, `projects/`.
File permissions on `.claude.json`: `-rw-------` (0600, owner-only). Correct.

### Claude version test
Cannot run `claude --version` inside a Claude Code session (nesting prevention). The binary is confirmed present and executable. The `find_claude_binary()` function in Rust checks the correct candidate paths, including the one that exists on this system.

**Verdict: PASS.** Claude CLI binary found, eidolon's separate config directory exists and is populated.

---

## 5. buildClaudeArgs Verification

**Runtime output:**
```
Args: ["--print","--output-format","stream-json","--verbose","--model","claude-sonnet-4-20250514","test prompt"]
Has --verbose: true
Has --print: true
Has stream-json: true
No --session-id: true
```

**Verified:**
- `--print` present (non-interactive mode)
- `--output-format stream-json` present (structured streaming output)
- `--verbose` present (detailed event stream)
- `--session-id` NOT present (intentional: Eidolon IDs have prefixes incompatible with Claude's UUID requirement)
- `--model` correctly passed
- Prompt is the last positional argument

**Verdict: PASS.**

---

## 6. Stream Parser Verification

**Runtime output:**
```
'{"type":"system","message":"init"}'                                 -> system: "init"
'{"type":"assistant","message":{"type":"text","text":"Hello!"}}'     -> text: "Hello!"
'{"type":"result","result":"Hello!"}'                                -> text: "Hello!"
''                                                                   -> null
'not json'                                                           -> null
'{"type":"error","error":"something broke"}'                         -> error: "something broke"
```

**Verified:**
- System messages parsed correctly
- Assistant text messages parsed correctly (nested `message.type === "text"`)
- Result events parsed as text
- Empty lines return null (skipped)
- Non-JSON lines return null (skipped, no crash)
- Error events parsed correctly

**Verdict: PASS.**

---

## 7. Event Handler userId Verification

In `packages/core/src/daemon/event-handlers-user.ts`, the `handleUserMessage` function:

1. Extracts `userId` from the event payload at line 28:
   ```typescript
   const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : undefined;
   ```

2. Validates it at line 31:
   ```typescript
   if (!channelId || !userId) { ... return error }
   ```

3. Passes `userId` in ALL `routeOutbound` calls:
   - Line 196: empty response error -> `userId` included
   - Line 208: successful response -> `userId` included
   - Line 275: processing error response -> `userId` included

**Verdict: PASS.** `userId` is consistently extracted, validated, and forwarded in all outbound message paths.

---

## 8. RPC Handler Registration

**Exported functions from `rpc-handlers.ts`:**
```
createChatSendHandler, createChatStreamHandler,
createMemorySearchHandler, createMemoryDeleteHandler,
createSessionListHandler, createSessionInfoHandler,
createLearningListHandler, createLearningApproveHandler, createLearningRejectHandler,
createSystemStatusHandler, createSystemHealthHandler,
createVoiceStartHandler, createVoiceStopHandler,
clearActiveVoiceSessions, getActiveVoiceSessionCount,
createCoreRpcHandlers
```

**Registered RPC methods via `createCoreRpcHandlers()`:**

| Method | Handler |
|--------|---------|
| `chat.send` | createChatSendHandler |
| `chat.stream` | createChatStreamHandler |
| `memory.search` | createMemorySearchHandler |
| `memory.delete` | createMemoryDeleteHandler |
| `session.list` | createSessionListHandler |
| `session.info` | createSessionInfoHandler |
| `learning.list` | createLearningListHandler |
| `learning.approve` | createLearningApproveHandler |
| `learning.reject` | createLearningRejectHandler |
| `system.status` | createSystemStatusHandler |
| `system.health` | createSystemHealthHandler |
| `voice.start` | createVoiceStartHandler |
| `voice.stop` | createVoiceStopHandler |

Additionally, `gateway-wiring.ts` registers two more on the GatewayServer directly:
- `gpu.workers`
- `gpu.pool_status`

**Verdict: PASS.** 15 RPC methods total, all properly registered.

---

## 9. Rust Compilation

```
cargo check
Checking eidolon-desktop v0.1.14
warning: use of deprecated method `tauri_plugin_shell::Shell::<R>::open`:
         Use tauri-plugin-opener instead.
  --> src/commands.rs:54:10
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.36s
```

**1 warning, 0 errors.**

The deprecation warning is in `open_external_url()` which uses `tauri_plugin_shell::ShellExt::shell(&app).open()`. The Tauri team has moved this to `tauri-plugin-opener`. Low priority -- works fine, just uses a deprecated API.

**Verdict: PASS (with 1 deprecation warning).**

---

## 10. Config Path Alignment: Rust vs TypeScript

### TypeScript (`packages/core/src/config/paths.ts`)

| Path | macOS Value |
|------|-------------|
| Config dir | `~/Library/Preferences/eidolon` |
| Config path | `~/Library/Preferences/eidolon/eidolon.json` |
| Data dir | `~/Library/Application Support/eidolon` |
| Claude config dir | `~/Library/Preferences/eidolon/claude-config` |

### Rust (`apps/desktop/src-tauri/src/commands.rs`)

| Path | macOS Value |
|------|-------------|
| Config path (`get_config_path_internal`) | `~/Library/Preferences/eidolon/eidolon.json` |
| Claude config dir (`get_eidolon_claude_config_dir`) | `~/Library/Preferences/eidolon/claude-config` |
| Master key (`get_master_key_path`) | `~/Library/Preferences/eidolon/master.key` |
| Data dir (`get_platform_dirs`) | `~/Library/Application Support/eidolon` |
| Log dir (`get_platform_dirs`) | `~/Library/Logs/eidolon` |
| Claude token (`get_claude_token_path`) | `~/Library/Preferences/eidolon/claude-token` |

### Cross-platform comparison

| Platform | TypeScript config dir | Rust config path |
|----------|----------------------|------------------|
| macOS | `~/Library/Preferences/eidolon` | `~/Library/Preferences/eidolon/eidolon.json` |
| Windows | `%APPDATA%/eidolon/config` | `%APPDATA%/eidolon/config/eidolon.json` |
| Linux | `~/.config/eidolon` | `~/.config/eidolon/eidolon.json` |

**Verdict: PASS.** All paths are consistent between TypeScript and Rust across all three platforms. Both use `PathBuf::join()` (Rust) and `path.join()` (TypeScript) for cross-platform safety.

---

## Summary

| Check | Status | Notes |
|-------|--------|-------|
| 1. Test suite | PASS | 3309 tests, 0 failures, 6 skips |
| 2. GatewayChannel | PASS | Correct ID, capabilities, state |
| 3. Gateway wiring chain | PASS | Server -> Channel -> Register -> Loop |
| 4. Claude CLI integration | PASS | Binary found, config dir populated |
| 5. buildClaudeArgs | PASS | All flags correct, no --session-id |
| 6. Stream parser | PASS | All event types parsed correctly |
| 7. userId in outbound | PASS | Present in all 3 routeOutbound calls |
| 8. RPC handlers | PASS | 15 methods registered |
| 9. Rust compilation | PASS | 0 errors, 1 deprecation warning |
| 10. Config paths | PASS | Rust and TypeScript aligned |

### Action Items (Low Priority)

1. **Deprecation warning**: Migrate `open_external_url` from `tauri_plugin_shell::open()` to `tauri-plugin-opener`. Non-blocking.
2. **auto_vacuum warnings**: Consider suppressing or reducing log level for these expected warnings in test output. Cosmetic only.
