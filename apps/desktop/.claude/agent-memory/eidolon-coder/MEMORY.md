# Eidolon Coder Agent Memory

## Project Structure (Desktop App)
- Tauri backend: `apps/desktop/src-tauri/src/commands.rs` -- all Tauri commands
- Svelte frontend: `apps/desktop/src/` -- Svelte 5 with runes ($state, $effect, $props)
- Connection store: `apps/desktop/src/lib/stores/connection.ts` -- GatewayClient lifecycle
- Chat store: `apps/desktop/src/lib/stores/chat.ts` -- message state + push handlers
- Dashboard store: `apps/desktop/src/lib/stores/dashboard.ts` -- polling + push subscriptions
- App root: `apps/desktop/src/App.svelte` -- routing, connection init, push handler wiring

## Key Patterns
- GatewayClient push handlers survive reconnects (registered on client object, not WebSocket)
- `onNewClient()` callback in connection.ts for re-registering handlers on new client instances
- Tauri async commands run on Tokio runtime -- use `tokio::time::sleep` not `std::thread::sleep`
- Tauri auto-serializes return values -- returning `serde_json::Value` avoids double-encoding
- Chat streaming lifecycle: streamingStore set true on send, cleared ONLY by push handlers or error

## Core Modules
- ClaudeCodeManager: `packages/core/src/claude/manager.ts` -- spawns Claude CLI subprocesses
- GatewayChannel: `packages/core/src/gateway/gateway-channel.ts` -- bridges router to WebSocket
- GatewayServer: `packages/core/src/gateway/server.ts` -- has broadcast() and sendTo(clientId)
- Event handlers: `packages/core/src/daemon/event-handlers-user.ts` -- processes user messages

## Conventions
- Svelte stores use module-level writable/derived -- persist across page navigation
- Temp files should use `std::env::temp_dir()` with random suffix + 0700 permissions
- Auth tokens in UI should be masked (first 4 + asterisks + last 4 chars)
