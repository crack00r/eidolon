# Round 11 Audit: Desktop (Tauri) & Web Applications

## HIGH Severity

1. **commands.rs god-module (1,161 lines)** -- apps/desktop/src-tauri/src/commands.rs
   All 18 Tauri command handlers in one file. Should split into auth, daemon, config, onboarding modules.

2. **AppleScript injection in setup_claude_token** -- commands.rs ~line 900+
   `setup_claude_token` builds AppleScript string with `claude_binary` path from `find_claude_binary()`.
   If binary path contains quotes/special chars, arbitrary AppleScript execution possible.
   Fix: shell-escape the path or use `Command::new` directly instead of AppleScript.

3. **CSP connect-src allows all ws:/wss: origins** -- tauri.conf.json:25
   `connect-src 'self' ws: wss: http://127.0.0.1:* ...` allows WebSocket to ANY origin.
   Fix: restrict to `ws://127.0.0.1:*` and `wss://127.0.0.1:*` (or specific Tailscale IPs).

4. **Web token in single sessionStorage key** -- apps/web/src/lib/stores/settings.ts
   Token stored alongside non-sensitive settings. Any XSS reads everything.
   Desktop correctly splits token into sessionStorage, connection into localStorage.

5. **Massive code duplication between desktop and web** -- api.ts, utils.ts, logger.ts, stores/*
   GatewayClient (~550 lines each), utils.ts (identical), logger.ts (identical),
   chat.ts/settings.ts/connection.ts (80%+ overlap). Should extract to shared package.

## MEDIUM Severity

1. Config path leaked in Rust error messages (commands.rs) -- user sees filesystem structure
2. Message size guard uses string `.length` not byte length (api.ts both apps)
3. Web chat.ts missing streaming timeout (desktop has 120s)
4. Web chat sends `{ message }` vs desktop `{ text }` -- protocol mismatch
5. `rand::thread_rng()` in commands.rs -- should use `OsRng` for token/key generation
6. Web hooks.server.ts allows env-configurable CSP connect-src -- injection if env compromised
7. start_daemon does not validate config_path before passing to sidecar
8. Dashboard store reads `$get(store)` pattern instead of Svelte 5 runes
9. health.ts unsafe type casts without field-level validation on server response
10. PushEventType enum diverges between desktop and web (missing members each side)

## LOW Severity

1. Seven files exceed 300-line limit: App.svelte (337), api.ts (549/586), chat/+page (370),
   dashboard/+page (689), memory/+page (517), learning/+page (355), settings/+page (853)
2. console.warn in discovery.ts without SEC-H4 comments
3. Duplicated path construction in Rust (get_config_path_internal called repeatedly)
4. theme.ts exports raw objects without Object.freeze -- mutable at runtime

## Test Coverage Gaps (WARNING)

- GatewayClient (desktop): 0 tests for 549-line class
- GatewayClient (web): 0 tests for 586-line class
- All desktop stores (chat, settings, dashboard, learning, memory, connection): 0 tests
- All web stores (chat, settings, connection, approvals, health, calendar, automations): 0 tests
- All Rust command handlers (commands.rs, lib.rs, tray.rs): 0 tests
- Svelte components/routes: 0 tests (no component testing setup)
- hooks.server.ts CSP header generation: 0 tests

## Verdict: REQUEST CHANGES
Primary blockers: CSP wildcard (security), code duplication (maintainability).
