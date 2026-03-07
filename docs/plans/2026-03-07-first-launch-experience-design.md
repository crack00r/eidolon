# First-Launch Experience Redesign

Date: 2026-03-07
Status: Approved

## Problem

The desktop app opens to an empty "disconnected" dashboard with no guidance.
Users must separately discover CLI onboarding, start the daemon manually, and
configure the client. The desktop app cannot connect to any server in its
default state due to CSP restrictions and TLS mismatches.

25 bugs/gaps identified in the audit (see appendix).

## Decision

Ansatz B: Embedded Bun. Tauri app starts a Bun subprocess running the existing
TypeScript daemon. Onboarding logic is shared between GUI and CLI.

## Design

### App Start

No config file at platform path -> show role selection screen.
Config present with `role: "server"` -> start daemon, show dashboard.
Config present with `role: "client"` -> auto-connect, show dashboard.

### Server Mode: 3 Screens

**Screen 1 -- "Name + Claude"**
- Text field: name (pre-filled from OS username)
- Button: "Connect with Claude" -> OAuth browser flow
- Small link: "Use API key instead" -> text field fallback
- Only screen requiring user input

**Screen 2 -- "Setting up..."**
- Animated checklist, no user input, ~3 seconds:
  - Generate master key (store in OS keychain, not file)
  - Initialize secret store
  - Create databases + run migrations
  - Configure network (auto-detect Tailscale, bind gateway)
  - Install CLI to PATH
- All with smart defaults: port 8419, auto-generated auth token,
  TLS off for local, Tailscale IP auto-bound if detected

**Screen 3 -- "Ready!"**
- Green status indicator
- QR code + pairing URL for other devices
- "Go to Dashboard" button

Extras (Telegram, GPU, advanced gateway) available in Settings after setup.

### Client Mode: 2 Screens

**Screen 1 -- "Find Server"**
Auto-discovery runs in parallel:
1. Tailscale peers (query tailscale CLI for devices in tailnet)
2. UDP broadcast (port 41920)
3. HTTP probe localhost:8419/health

Found servers shown as selectable list with name + IP.
Fallback options: scan QR code, paste pairing URL, manual host/port/token entry.

**Screen 2 -- "Connected!"**
- Shows server name + version
- "Go to Dashboard" button

### Embedded Daemon

- Tauri app spawns `bun run` with daemon entry point as child process
- Daemon lifecycle tied to app: app close = daemon stop (SIGTERM)
- Communication via existing WebSocket gateway (ws://127.0.0.1:8419)
- Stdout/stderr piped to Tauri for log display

### Shared Onboarding Logic

New module: `packages/core/src/onboarding/`
- `setup-checks.ts` -- system prerequisite checks
- `setup-identity.ts` -- name, master key, secret store
- `setup-claude.ts` -- OAuth flow, API key fallback
- `setup-network.ts` -- gateway, Tailscale, discovery
- `setup-database.ts` -- DB init + migrations
- `setup-extras.ts` -- Telegram, GPU (optional)
- `setup-finalize.ts` -- write config, health check

CLI `eidolon onboard` becomes thin wrapper calling these modules with
readline-based prompts. Desktop calls same modules via Tauri commands.

### CSP Fix

Change `tauri.conf.json` CSP from:
```
connect-src 'self' wss://localhost:* wss://127.0.0.1:*
```
To:
```
connect-src 'self' ws://localhost:* wss://localhost:* ws://127.0.0.1:* wss://127.0.0.1:* ws://*.ts.net:* wss://*.ts.net:*
```

### Config Schema Update

Add to EidolonConfigSchema:
```typescript
role: z.enum(["server", "client"]).default("server")
```

Client config uses same schema with `role: "client"` and a new optional
`server` block for remote connection details.

## Bug Fixes Included

All 25 issues from the audit resolved in this release:

**Critical:**
- CSP allows ws:// + wss:// + Tailscale domains
- TLS defaults aligned (both off for local)
- Desktop gets first-run experience
- `--config` flag passed through to daemon

**Major:**
- VERSION constant reads from package.json
- Sidebar version from Tauri API (not hardcoded)
- Client config matches EidolonConfigSchema
- Daemon without config shows helpful message
- Gateway auth default changed to "none" (token generated during onboarding)

**Minor:**
- Master key in OS keychain instead of file on disk
- Mid-wizard cancellation cleanup
- Background daemon logs accessible via `eidolon daemon logs`

## Appendix: Audit Bug List

| ID | Severity | Description |
|----|----------|-------------|
| O-1/D-1 | Critical | --config flag silently ignored |
| A-4 | Critical | CSP blocks non-localhost WebSocket |
| A-1 | Critical | No first-run experience |
| I-1 | Critical | No path from desktop to working server |
| A-5/A-6 | Critical | TLS mismatch + CSP blocks ws:// |
| V-1/O-2 | Major | VERSION constant is "0.0.0" |
| O-6/C-2 | Major | Client config invalid schema |
| D-2 | Major | No config = crash without guidance |
| A-3/V-3 | Major | Hardcoded "v0.1.0" in sidebar |
| C-1 | Major | Gateway auth default catch-22 |
| A-2 | Major | No auto-connect on launch |
| A-10 | Major | Updater pubkey placeholder |
| V-2 | Major | Tauri version out of sync |
| O-3 | Minor | No mid-wizard cleanup |
| O-4 | Minor | Master key file on disk |
| O-5 | Minor | No master key strength check |
| O-7 | Minor | Client token in plaintext |
| D-3 | Minor | Missing master key skips secrets |
| D-4 | Minor | Background mode no stdout |
| D-5 | Minor | No daemon logs command |
| A-7 | Minor | Two parallel discovery impls |
| A-8 | Minor | Discovery doesn't fill token |
| A-9 | Minor | No deep link handler |
| I-2 | Minor | Settings lost on close |
| V-4 | Minor | No version compat check |
