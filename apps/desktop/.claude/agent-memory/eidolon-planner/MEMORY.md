# Eidolon Planner Memory

## Desktop App Architecture (confirmed 2026-03-08)

### Tauri Backend (src-tauri/)
- `commands.rs`: ~1055 lines, 19 registered Tauri commands
- `tray.rs`: System tray with show/hide/quit, graceful daemon stop on quit
- `lib.rs`: DaemonState managed state (Mutex<Option<CommandChild>>)
- Daemon runs as a sidecar process (`eidolon-cli daemon start --foreground`)
- Window hide on close (not destroy) so daemon keeps running

### Frontend (src/)
- Svelte 5 with runes ($state, $derived, $effect, $props)
- SPA routing via state machine in App.svelte (no SvelteKit)
- Stores: connection, settings, dashboard, chat, memory, learning
- WebSocket client: `GatewayClient` class in `lib/api.ts`
- JSON-RPC 2.0 protocol over WebSocket on port 8419

### Key File Paths
- Gateway server: `packages/core/src/gateway/server.ts`
- RPC handlers: `packages/core/src/gateway/rpc-handlers*.ts`
- Builtin handlers: `packages/core/src/gateway/builtin-handlers*.ts`
- Gateway channel (chat push): `packages/core/src/gateway/gateway-channel.ts`
- Protocol types: `packages/protocol/src/types/gateway.ts`
- Feedback handlers: `packages/core/src/feedback/gateway-handlers.ts`
- Message router: `packages/core/src/channels/router.ts`
- Gateway wiring: `packages/core/src/daemon/gateway-wiring.ts`

### Chat Message Flow (verified Round 5, full data-shape trace)
1. Frontend: `sendMessage()` -> placeholder "Thinking..." + `client.call("chat.send", {text})`
2. Backend: `createChatSendHandler` -> Zod validates -> EventBus `user:message` (userId=clientId)
3. CogLoop: `handleUserMessage()` -> workspace prep -> ClaudeManager.run() -> collect response
4. Backend: `messageRouter.routeOutbound({channelId:"gateway", userId, text, format:"markdown"})`
5. Backend: `GatewayChannel.send()` -> builds push.chatMessage -> `server.sendTo(userId, pushEvent)`
6. Frontend: `push.chatMessage` handler finds streaming placeholder, replaces content, sets streaming=false

### Push Events (server -> client)
- `push.chatMessage` -> GatewayChannel.send() targets via sendTo(userId) or broadcasts
- `push.stateChange` -> brain.pause/resume handlers
- `push.clientConnected/Disconnected` -> client-manager.ts
- `push.executeCommand` -> client.execute relay
- `system.statusUpdate` -> broadcastStatus() via dashboard push handler
- `push.taskStarted/taskCompleted` -> defined in types but NEVER EMITTED by backend

## Audit Findings Summary (2026-03-08)
- Round 1: `docs/audit-round-1.md` -- 3C, 4H, 7M, 9L (all C/H/M fixed)
- Round 2: `docs/audit-round-2.md` -- 0C, 2H, 7M, 6L
- Round 3: `docs/audit-round-3.md` -- 0C, 3H, 7M, 8L
- Round 4: `docs/audit-round-4.md` -- 0C, 3H, 7M, 8L
- Round 5: `docs/audit-round-5.md` -- 0C, 0H, 4M, 4L (integration + regression)
- Round 6-7: `docs/audit-round-6-7.md` -- 0C, 0H, 2M, 8L (code quality + UX)
- All C/H issues FIXED. All R1-4 fixes CONFIRMED intact.

### Remaining Unfixed Issues (after Round 7)
- R4-M4: Deprecated Shell::open (Rust warning)
- R4-M5: setup_claude_token macOS-only (uses osascript)
- R5-M4: push.taskStarted/taskCompleted types never emitted (dead types)
- R6-M1: RESOLVED -- all serde_json calls are json!() macros or guarded by if-let-Ok
- R6-M2: stop_daemon poll loop acquires mutex on every iteration
- R4-L2: rateMessage uses messageId as sessionId
- R4-L4: onboard_setup_server hardcodes port 8419
- R5-L1: appendStreamChunk is dead code
- R6-L1: dashboardLoading export defined but never consumed
- R6-L2: Connection error message is generic
- R7-L1: Dashboard shows defaults during initial load (no loading indicator)
- R7-L2: Dashboard error banner not dismissible
- R7-L3: Memory detail panel fixed 360px, no responsive breakpoint
- R7-L4: Sidebar has no collapse behavior

### Previously Reported Issues Now FIXED
- R5-M1: onNewClient -- FIXED (returns unsubscribe function)
- R5-M2: Tray quit busy-wait -- FIXED (uses tokio async task)
- R5-M3: setup_claude_token blocking I/O -- FIXED (uses spawn_blocking)
- R4-L3: discover_servers co-located -- FIXED (handles AddrInUse)
- R5-L2: cancelEdit/saveEdit dead code -- REMOVED from codebase

### Architecture Insights from Audits
- CSP now uses `ws: wss:` for connect-src (allows remote WebSocket)
- OutboundMessage has userId (Round 3 H-1 FIXED, confirmed Round 5)
- CLAUDE_CONFIG_DIR passed to sidecar via env (Round 4 H-1 FIXED)
- PathBuf::join used for all Rust paths (cross-platform correct)
- Single RpcValidationError class in rpc-schemas.ts (Round 4 L-5 FIXED)
- clearStreamingState called on disconnect+error (Round 4 L-6 FIXED)
- Send-while-streaming prevention via streamingStore check
- Config paths match between Rust and TS on all platforms
- No `{@html}` in Svelte templates (safe from XSS)
- Sidecar binary: `binaries/eidolon-cli-aarch64-apple-darwin` (Tauri appends triple)
- Practical Rust audit: `docs/practical-audit-r1-rust.md` (2026-03-08)
  - 0C/0H/2M/5L -- compiles clean, all commands verified
  - NEW M-1: Windows data_dir mismatch (Rust `%APPDATA%/eidolon/data` vs TS `%APPDATA%/eidolon`)
  - R6-M1 RESOLVED (no unsafe unwrap on serde_json)
  - 3 unused commands: open_external_url, read_claude_token, has_claude_token, daemon_running
- Practical Frontend audit: `docs/practical-audit-r1-frontend.md` (2026-03-08)
  - 0C/0H/0M/2L -- ALL invoke calls match, lifecycle correct, chat flow verified
  - svelte-check: 0 errors, 0 warnings, 137 files
  - Zero {@html} usage (no XSS surface)
  - Zero Svelte 4 patterns ($: blocks) -- all Svelte 5 runes
  - 7 unused Tauri commands (get_platform, get_version, open_external_url, stop_daemon, daemon_running, read_claude_token, has_claude_token)
  - All 10 RPC methods verified against backend protocol.ts
  - Tauri camelCase->snake_case auto-conversion confirmed working for parameter names
