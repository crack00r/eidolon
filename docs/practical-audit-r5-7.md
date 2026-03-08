# Practical Audit -- Rounds 5-7

**Date**: 2026-03-08
**Auditor**: eidolon-tester agent
**Scope**: Error path verification, security re-verification, full final verification

---

## Round 5: Error Path Verification

### 5.1 Claude CLI Not Installed

**Files examined**: `packages/core/src/claude/manager.ts`

**`isAvailable()` behavior** (line 241-252):
- Runs `Bun.spawnSync([findClaudeBinary(), "--version"])`.
- If spawn throws (binary not found), catches the error and returns `false`.
- If exit code is non-zero, returns `false`.
- VERDICT: Clean boolean check, no crash. Callers can gate on this before attempting `run()`.

**`getVersion()` behavior** (line 257-270):
- Returns `Result<string, EidolonError>` using the `Err(createError(ErrorCode.CLAUDE_NOT_INSTALLED, ...))` pattern.
- Both non-zero exit code and spawn exception are handled.
- VERDICT: Correct Result pattern usage.

**`run()` behavior when binary is missing** (line 59-236):
- `findClaudeBinary()` (line 21-37) searches 4 common paths; if none exist, falls back to bare `"claude"`.
- `Bun.spawn(["claude", ...])` will fail if `claude` is not on PATH.
- **Issue found**: If `Bun.spawn()` throws synchronously (e.g., ENOENT), the error propagates as an uncaught exception from the generator. There is no try/catch around `Bun.spawn()` itself (line 145).
- **Mitigation**: The caller (`handleUserMessage`) wraps the entire `for await` loop in a try/catch (line 266-284) and sends an error message back to the user via `messageRouter.routeOutbound()`.
- VERDICT: The error IS caught and the user DOES receive a message: "Sorry, I was unable to process your message. Please try again." The error is logged. **However**, the error message to the user is generic -- it does not tell them Claude CLI is missing. This could be improved with specific error detection.

**Recommendation**: Wrap `Bun.spawn()` in `run()` with a try/catch that yields a specific `error` StreamEvent with a "Claude CLI not found" message before re-throwing or returning.

### 5.2 Claude Auth Expires

**Files examined**: `packages/core/src/claude/parser.ts`, `packages/core/src/claude/manager.ts`

**Flow when Claude returns an auth error**:
1. Claude CLI exits with non-zero exit code.
2. `manager.ts` line 215-223: yields `{ type: "error", error: "Claude Code exited with code X" }` and logs stderr.
3. `parser.ts` line 68-73: If Claude emits `{"type": "error", ...}` in its stream output, it IS parsed into a StreamEvent with type `"error"`.
4. `event-handlers-user.ts` line 169-172: Error stream events are logged but NOT forwarded to the user as text.
5. After the stream ends with errors, `responseChunks` is likely empty, triggering the empty-response path (line 186-199) which sends "I wasn't able to generate a response. Please try again."

**VERDICT**: Auth errors DO reach the user, but only as a generic "couldn't generate response" message. The specific auth error from stderr is logged server-side but never surfaced to the UI.

**Recommendation**: Parse the error StreamEvent in `handleUserMessage` and include the error detail in the message sent back to the channel, so users know they need to re-authenticate.

### 5.3 WebSocket Disconnects Mid-Chat

**Files examined**: `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/stores/chat.ts`, `apps/desktop/src/lib/stores/connection.ts`

**WebSocket onclose** (`api.ts` line 341-351):
- Calls `rejectAllPending("Connection closed")` -- all pending RPC promises are rejected with an Error.
- Sets state to "disconnected" (or schedules reconnect if `shouldReconnect` is true).

**Pending RPC calls** (`api.ts` line 539-545):
- `rejectAllPending()` iterates all pending requests, clears their timers, and rejects their promises.
- VERDICT: No orphaned promises. All pending calls fail fast with "Connection closed".

**Chat store** (`chat.ts` line 83-100):
- `sendMessage()` catch block: Sets the assistant message to `"Error: ..."` and clears `streamingStore`.
- However, this only handles errors during the initial `chat.send` RPC call. If the WS disconnects AFTER `chat.send` succeeds (while waiting for the `push.chatMessage` response), the streaming placeholder ("Thinking...") would remain.

**Connection store** (`connection.ts` line 31-43):
- On state `"error"`: calls `clearStreamingState()`.
- On state `"disconnected"`: calls `clearStreamingState()`.
- VERDICT: `streamingStore` IS correctly cleared on both error and disconnect states.

**Remaining issue**: When WS disconnects after `chat.send` succeeds but before the push response arrives, the "Thinking..." placeholder message remains in the message list with `streaming: false` (because `clearStreamingState` only clears the boolean store, not the message content). The user sees a stale "Thinking..." message that never resolves.

**Recommendation**: When `clearStreamingState()` is called, also update any messages with `streaming: true` to show a disconnect error. Alternatively, the `clearStreamingState` function could replace streaming message content with "Connection lost. Message may still be processing."

### 5.4 `onboard_setup_server` Failure

**File examined**: `apps/desktop/src/routes/onboarding/ServerSetup.svelte`

**`runSetup()` (line 83-129)**:
- Wrapped in try/catch.
- On error: Sets `setupError` to the error message string.
- Updates the checklist: finds the first item with `"running"` status and marks it `"error"`.
- The template (line 264-271) displays the error in an `ed-banner--error` with a **Retry** button that calls `runSetup()` again.

**VERDICT**: Error IS displayed. User CAN retry. The retry resets all checklist items to "pending" and re-runs the setup. This is a solid error recovery flow.

**Minor note**: If the Tauri command throws before any checklist item is set to "running" (e.g., validation failure in Rust), only `checklist[0]` would have been set to "running" (line 90), so it would correctly show the first item as errored. No edge case gap here.

---

## Round 6: Security Re-verification

### 6.1 Injection Vectors

**`@html` usage**: NONE in production code. The only occurrence is a **comment** in `+page.svelte` line 81 explicitly warning against using raw HTML rendering without DOMPurify. All message rendering uses Svelte's default text interpolation (`{msg.content}`), which auto-escapes HTML entities.

**Direct DOM manipulation / raw HTML insertion**: Zero occurrences across all `.ts` and `.svelte` files.

**Dynamic code execution**: Zero occurrences across all `.ts` and `.svelte` files.

**VERDICT**: No XSS injection vectors found. The codebase is defensive with an explicit comment warning future developers.

### 6.2 API Keys/Tokens in Logs

**`console.log` with token/key/secret/password**: Zero occurrences in both `apps/desktop/src/` and `packages/core/src/`.

The project uses a structured logging system (`Logger` class) rather than raw `console.log`. Reviewing `manager.ts`:
- Line 67-70: Logs session start with sessionId and model only (no secrets).
- Line 128: Warns about rejected dangerous env vars by key name only (no values).
- Line 223: Logs Claude stderr content, which could theoretically contain sensitive data if Claude CLI prints it. This is an acceptable risk as it goes to the server log, not the client.

**ServerSetup.svelte** (line 107-112): The pairing URL displayed in the UI has the token **masked** (`****` in the middle). The full token is only available via the Copy button (clipboard). This is proper secret handling.

**VERDICT**: No secret leakage in logs. Token masking in the UI is correctly implemented.

### 6.3 CSP Verification

**CSP from `tauri.conf.json`**:
```
default-src 'self';
script-src 'self';
connect-src 'self' ws: wss: http://127.0.0.1:* https://127.0.0.1:* ipc: http://ipc.localhost;
style-src 'self' 'unsafe-inline'
```

**Analysis**:
- `default-src 'self'`: Good. No external resource loading by default.
- `script-src 'self'`: Good. No inline scripts, no external script sources, no unsafe-eval.
- `connect-src`: Allows `ws:` and `wss:` broadly (any host). This is needed for connecting to the gateway on various Tailscale IPs, but it does mean the app could connect to any WebSocket server. The hostname validation in `api.ts` (line 79: `HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/`) mitigates URL injection.
- `style-src 'self' 'unsafe-inline'`: Common for Svelte apps that use scoped `<style>` tags. Acceptable tradeoff.
- No `img-src` directive: Falls back to `default-src 'self'`, preventing external image loading.
- No `font-src` directive: Falls back to `default-src 'self'`.

**Issues**:
1. `connect-src ws: wss:` is broad -- allows WebSocket to any host, not just `127.0.0.1` or Tailscale IPs. In practice this is controlled by the settings store, but a compromised script could open connections elsewhere.

**VERDICT**: CSP is reasonable for a Tauri desktop app. The broad `ws:` / `wss:` in connect-src is the only notable point, justified by multi-device Tailscale use case.

---

## Round 7: Full Final Verification

### 7.1 TypeScript Type Checking

```
pnpm -r typecheck
```

**Result**: ALL CLEAR
- packages/protocol: PASS
- packages/test-utils: PASS
- packages/core: PASS
- packages/cli: PASS
- apps/desktop: 137 files, 0 errors, 0 warnings
- apps/web: 354 files, 0 errors, 0 warnings

**Zero type errors across the entire monorepo.**

### 7.2 Test Suite

```
pnpm -r test
```

**Result**: ALL PASS

| Package | Pass | Skip | Fail | Files | Time |
|---------|------|------|------|-------|------|
| apps/web | 35 | 0 | 0 | 3 | 8ms |
| packages/protocol | 100 | 0 | 0 | 1 | 18ms |
| apps/desktop | 32 | 0 | 0 | 3 | 82ms |
| packages/test-utils | 24 | 0 | 0 | 5 | 336ms |
| packages/core | 2941 | 6 | 0 | 196 | 25.88s |
| packages/cli | 171 | 0 | 0 | 10 | 6.24s |
| **TOTAL** | **3303** | **6** | **0** | **218** | **~32s** |

- 6 skipped tests are in core (conditional/environment-gated, not `it.skip` calls).
- All `auto_vacuum` warnings are expected and harmless (existing SQLite DB behavior in tests).

### 7.3 Rust (Cargo Check)

```
cargo check (apps/desktop/src-tauri)
```

**Result**: PASS with 1 warning
- Warning: `tauri_plugin_shell::Shell::open` is deprecated; should migrate to `tauri-plugin-opener`.
- This is a non-blocking deprecation notice, not a compilation error.

### 7.4 Svelte Check

```
npx svelte-check
```

**Result**: 137 files, 0 errors, 0 warnings, 0 files with problems.

### 7.5 Lint

```
pnpm -r lint
```

**Result**: PASS with 1 info-level suggestion
- `packages/core`: 1 info about an unnecessary constructor in `GitAnalyzer` class. Not an error.
- All other packages: clean.

---

## Summary of Findings

### Issues Found (by severity)

#### Low Severity
1. **Generic error messages for Claude CLI failures** (5.1, 5.2): When Claude CLI is missing or auth expires, the user receives a generic "unable to process" / "try again" message. The specific cause is only logged server-side. Users would benefit from specific error messages like "Claude CLI not found -- run eidolon doctor" or "Authentication expired -- re-authorize".

2. **Stale "Thinking..." message on WS disconnect** (5.3): If the WebSocket disconnects after `chat.send` succeeds but before the push response arrives, the streaming boolean is cleared but the "Thinking..." placeholder text remains visible in the message list.

3. **Deprecated Tauri plugin usage** (7.3): `tauri_plugin_shell::Shell::open` should be migrated to `tauri-plugin-opener` to avoid future breakage.

4. **Broad WebSocket CSP** (6.3): `connect-src ws: wss:` allows connections to any WebSocket host. Could be tightened if the set of gateway hosts is known at build time.

#### Info (No Action Required)
- 6 skipped tests in core are environment-gated, not `it.skip` violations.
- 1 Biome info-level lint suggestion (unnecessary constructor).
- `auto_vacuum` test warnings are expected behavior.

### All Clear
- Zero type errors across 6 packages
- 3303 tests pass, 0 failures
- Zero XSS vectors (no raw HTML rendering, no direct DOM manipulation, no dynamic code execution)
- Zero secret leakage in console.log
- Token masking in ServerSetup UI is correct
- Error display and retry in onboarding works correctly
- Pending RPC calls are properly rejected on WS disconnect
- Streaming state is cleared on disconnect/error via connection store

---

## Recommended Actions

| Priority | Action | Effort |
|----------|--------|--------|
| Low | Surface specific Claude CLI errors to user (not found, auth expired) | Small |
| Low | Clear "Thinking..." message content on WS disconnect | Small |
| Low | Migrate from tauri-plugin-shell to tauri-plugin-opener | Small |
| Low | Consider tightening CSP connect-src for ws/wss | Small |
