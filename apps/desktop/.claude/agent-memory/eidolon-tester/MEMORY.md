# Eidolon Tester Agent Memory

## Test Suite Facts (verified 2026-03-08)
- Total tests: 3309 across 6 packages (core: 2947, cli: 171, protocol: 100, web: 35, desktop: 32, test-utils: 24)
- 6 skipped tests in core (likely conditional/env-gated, no `it.skip` in source)
- Zero `it.skip` or `.skip(` calls found in any test file
- Test runner: bun test v1.3.10

## Key Source File Locations
- Gateway channel: `packages/core/src/gateway/gateway-channel.ts`
- Gateway wiring: `packages/core/src/daemon/gateway-wiring.ts`
- Daemon entry: `packages/core/src/daemon/index.ts`
- Claude args builder: `packages/core/src/claude/args.ts`
- Stream parser: `packages/core/src/claude/parser.ts`
- Config paths: `packages/core/src/config/paths.ts`
- RPC handlers: `packages/core/src/gateway/rpc-handlers.ts` (barrel re-exports from 3 sub-modules)
- Event handler (user): `packages/core/src/daemon/event-handlers-user.ts`
- Rust commands: `apps/desktop/src-tauri/src/commands.rs`

## Runtime Verification Notes
- Cannot run `claude --version` inside Claude Code session (nesting prevention)
- Claude CLI binary at `~/.local/bin/claude` (symlink to versioned path)
- Eidolon's Claude config dir exists at `~/Library/Preferences/eidolon/claude-config/`
- `bun -e "require(...)"` works for quick runtime verification of TS modules

## Common Test Warnings (safe to ignore)
- `auto_vacuum=INCREMENTAL could not be set` -- normal for existing SQLite DBs in tests
- Structured-output retry exhaustion logs -- expected from error path tests
- Golden dataset extraction metrics (30% recall) -- by design for rule-based fallback

## Daemon Init Order (verified)
1. Core init (steps 1-16g, 17b)
2. Channel wiring (step 17)
3. Gateway steps (18-21): GPU -> STT -> GatewayServer -> GatewayChannel -> CoreRPC -> ...
4. PID file + signal handlers
5. CognitiveLoop.start() -- LAST

## RPC Methods (15 total)
chat.send, chat.stream, memory.search, memory.delete,
session.list, session.info, learning.list, learning.approve, learning.reject,
system.status, system.health, voice.start, voice.stop,
gpu.workers, gpu.pool_status
