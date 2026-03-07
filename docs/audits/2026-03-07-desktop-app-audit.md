# Desktop App Post-Mortem Audit (2026-03-07)

## Context

The Eidolon Desktop App v0.1.11 was released and built successfully in CI, but
failed on first launch for end users. This audit documents what went wrong, why
it was not caught, what other similar problems exist, and what testing gaps must
be closed.

---

## 1. What Went Wrong

### 1.1 Root Cause: `start_daemon` uses dev-only relative path

**File**: `apps/desktop/src-tauri/src/commands.rs`, lines 176-196

The `start_daemon` Tauri command spawns bun with a hardcoded relative path to
the monorepo source:

```rust
let mut args = vec![
    "run".to_string(),
    "packages/cli/src/index.ts".to_string(),  // <-- THIS
    "daemon".to_string(),
    "start".to_string(),
    "--foreground".to_string(),
];
// ...
let child = Command::new("bun")  // <-- assumes `bun` is on PATH
    .args(&args)
    .spawn()
```

**Problems:**
1. `packages/cli/src/index.ts` is a monorepo-relative path. In an installed
   app (DMG/AppImage/NSIS), the working directory is NOT the monorepo root.
   The file simply does not exist.
2. `bun` is assumed to be on the system PATH. End users do not have Bun
   installed -- it is a developer tool, not an end-user runtime.
3. No error is surfaced to the user. `App.svelte` line 86-88 catches the
   error silently: `catch { // Non-fatal -- dashboard will show the error state }`

### 1.2 Previous Issue: `bun eval` vs `bun -e`

The user reported that `bun eval` was used instead of `bun -e`. Looking at the
current code, this has already been fixed -- `run_bun_script` (line 265-277)
now correctly uses `bun -e`. However, the underlying problem remains: the
`run_bun_script` command still assumes `bun` is available on the end user's
system.

### 1.3 Impact

- **Server role**: App starts, shows onboarding, completes setup (config is
  written via pure Rust -- this part works), then calls `start_daemon` which
  silently fails. The dashboard shows but the daemon is not running, and the
  user sees no clear error explaining why.
- **Client role**: App starts, shows onboarding, discovery/connection works
  (pure Rust + HTTP). The client role is less affected because it does not
  try to start the daemon.

---

## 2. Why It Was Not Caught

### 2.1 No Desktop-Specific Tests in CI

The CI pipeline (`ci.yml`) runs:
- `pnpm -r lint`
- `pnpm -r typecheck`
- `pnpm -r build` (builds TypeScript/Svelte frontend only)
- `pnpm -r test` (runs bun tests)

**It does NOT:**
- Compile the Rust/Tauri backend
- Run `cargo test` for the Rust code
- Build the actual Tauri app bundle
- Run any integration or smoke tests

The desktop Tauri build only happens in `build-desktop.yml`, which is
triggered **only on release** (via `release.yml` after release-please creates
a tag). This means:
- PRs and pushes to main never compile the Rust code
- The desktop build is never tested before release
- Even the release build only checks compilation, not runtime behavior

### 2.2 Zero Rust Tests

There are **zero** `#[test]` or `#[cfg(test)]` blocks anywhere in the Rust
codebase (`commands.rs`, `lib.rs`, `main.rs`, `tray.rs`). The Rust code has
never been unit-tested.

### 2.3 Frontend Tests Are Purely Unit-Level

The desktop app has 3 test files with pure unit tests:
- `src/lib/utils.test.ts` (7 tests) -- string sanitization
- `src/lib/discovery.test.ts` (14 tests) -- beacon validation logic
- `src/lib/logger.test.ts` (9 tests) -- ring buffer logging

None of these test:
- Tauri command invocations
- The onboarding flow end-to-end
- The daemon lifecycle
- What happens when external tools are missing

### 2.4 `continue-on-error: true` in Build Workflow

`build-desktop.yml` line 33: `continue-on-error: true`. This means even if the
desktop build FAILS on a platform, the release workflow continues and publishes.
Build failures are silently swallowed.

### 2.5 No Smoke Test After Build

The build workflow compiles the app and uploads artifacts. It never:
- Launches the built app
- Verifies the app window opens
- Checks that Tauri commands respond
- Validates that required external tools exist or are bundled

---

## 3. Additional Problems Found (Same Category)

### 3.1 `start_daemon` -- Multiple Fatal Issues

**File**: `apps/desktop/src-tauri/src/commands.rs`, lines 170-196

| Issue | Severity | Description |
|-------|----------|-------------|
| Hardcoded dev path | CRITICAL | `packages/cli/src/index.ts` does not exist in installed app |
| Assumes `bun` on PATH | CRITICAL | End users do not have Bun installed |
| No config_path passed | HIGH | `start_daemon` requires `config_path` but `App.svelte` calls it without arguments (line 65, 86) |
| No CWD set | HIGH | `Command::new("bun")` inherits the process CWD, which varies per OS/launch method |
| Silent failure | MEDIUM | Errors are caught and ignored in `App.svelte` |

### 3.2 `run_bun_script` -- Assumes Bun Available

**File**: `apps/desktop/src-tauri/src/commands.rs`, lines 265-277

This command lets the frontend execute arbitrary JavaScript via `bun -e`. It:
- Assumes `bun` is on PATH (will fail for end users)
- Is not called from any Svelte component currently (grep shows zero invocations in `.svelte` files), but is registered as a Tauri command and could be called
- Executes arbitrary code -- potential security concern if ever exposed to untrusted input

### 3.3 `detect_tailscale_ip` -- Assumes Tailscale on PATH

**File**: `apps/desktop/src-tauri/src/commands.rs`, lines 347-355

Calls `Command::new("tailscale")` without checking if Tailscale is installed.
This is handled gracefully (returns `None` on failure), so it is not a crash
bug. However, on some platforms `Command::new` for a missing binary can trigger
OS-level error dialogs.

### 3.4 `discover_servers` Invocation Mismatch (ClientSetup)

**File**: `apps/desktop/src/routes/onboarding/ClientSetup.svelte`, line 49

```typescript
const found = await invoke<DiscoveredServer[]>("discover_servers");
```

The Rust command signature is `discover_servers(timeout_ms: u64)` -- the
parameter is required. ClientSetup calls it without `timeoutMs`, which may
cause a Tauri deserialization error at runtime. Compare with Settings page
(line 93) which correctly passes `{ timeoutMs: 3000 }`.

### 3.5 Version Mismatch Between package.json and Cargo.toml

- `apps/desktop/package.json`: version `0.1.11`
- `apps/desktop/src-tauri/Cargo.toml`: version `0.1.7`
- `apps/desktop/src-tauri/tauri.conf.json`: version `0.1.11`

Cargo.toml is 4 versions behind. This means the Rust binary reports the wrong
version via `get_version()` (which uses `env!("CARGO_PKG_VERSION")`).

### 3.6 Updater Public Key is a Placeholder

**File**: `apps/desktop/src-tauri/tauri.conf.json`, line 53

The `pubkey` field contains a base64 string. The comment in `lib.rs` (lines
8-13) warns that this MUST be replaced with a real Ed25519 key before
production. If this is a placeholder, update signature verification is
effectively bypassed, allowing arbitrary code execution via malicious update
payloads.

### 3.7 CSP Allows Wide WebSocket/HTTP Ranges

**File**: `apps/desktop/src-tauri/tauri.conf.json`, line 25

The Content Security Policy allows connections to `ws://*.ts.net:*` and
`http://*.ts.net:*` on any port. While this is needed for Tailscale, it is
broader than necessary.

---

## 4. Testing and CI Gaps

### 4.1 Missing Tests

| Category | What's Missing | Priority |
|----------|---------------|----------|
| Rust unit tests | Zero `#[test]` blocks in any `.rs` file | CRITICAL |
| Tauri command tests | No tests for any of the 15 registered commands | CRITICAL |
| Daemon lifecycle test | `start_daemon`/`stop_daemon` never tested | CRITICAL |
| Onboarding integration | No test that walks through the onboarding flow | HIGH |
| External tool detection | No test for `bun`/`tailscale` availability | HIGH |
| Config file operations | `check_config_exists`, `get_config_role`, `save_client_config` untested in Rust | HIGH |
| Path resolution | `get_config_path_internal` and `get_platform_dirs` untested | MEDIUM |
| UDP discovery | `discover_servers` untested (needs mock socket) | MEDIUM |
| Svelte component tests | No component tests for any of the 10 Svelte files | LOW |

### 4.2 Missing CI Steps

| Step | Current State | Should Be |
|------|--------------|-----------|
| Cargo check in CI | Not run on push/PR | `cargo check` on every PR |
| Cargo test in CI | Not run ever | `cargo test` on every PR |
| Cargo clippy | Not run | `cargo clippy -- -D warnings` on every PR |
| Desktop build on PR | Only on release | At least `cargo check` + `vite build` on PR |
| Smoke test after build | Never | Launch app, verify window opens, verify health endpoint |
| Version sync check | Not checked | Fail CI if package.json/Cargo.toml/tauri.conf.json versions diverge |

### 4.3 Missing Smoke Tests

A minimal smoke test suite for the desktop app should verify:

1. **App launches**: The Tauri window opens without crashes
2. **Onboarding flow renders**: The RoleSelect screen appears when no config exists
3. **Config write/read roundtrip**: `onboard_setup_server` creates a valid config file,
   `check_config_exists` returns true, `get_config_role` returns the correct role
4. **External tool detection**: Report whether `bun` and `tailscale` are available
   instead of silently failing
5. **Daemon start validation**: Before calling `Command::new("bun")`, verify that
   the bun binary exists and the CLI entry point is accessible

---

## 5. Svelte Component to Tauri Command Flow

### 5.1 Complete Invocation Map

```
App.svelte
  |-- onMount()
  |     |-- invoke("check_config_exists")        -> commands::check_config_exists
  |     |-- invoke("get_config_role")             -> commands::get_config_role
  |     |-- invoke("start_daemon")                -> commands::start_daemon [BROKEN]
  |     '-- invoke("get_client_config")           -> commands::get_client_config
  |
  |-- RoleSelect.svelte
  |     '-- (no Tauri invocations -- pure UI)
  |
  |-- ServerSetup.svelte
  |     |-- onMount()
  |     |     '-- invoke("get_os_username")       -> commands::get_os_username
  |     |
  |     '-- runSetup()
  |           '-- invoke("onboard_setup_server")  -> commands::onboard_setup_server
  |
  |-- ClientSetup.svelte
  |     |-- onMount()
  |     |     '-- invoke("discover_servers")      -> commands::discover_servers [MISSING PARAM]
  |     |
  |     |-- connectToServer()
  |     |     '-- fetch(`http://${host}:${port}/health`)  (direct HTTP, not Tauri)
  |     |     '-- invoke("save_client_config")    -> commands::save_client_config
  |     |
  |     '-- (handleOnboardingComplete in App.svelte)
  |           |-- invoke("get_config_role")       -> commands::get_config_role
  |           '-- invoke("start_daemon")          -> commands::start_daemon [BROKEN]
  |
  |-- SettingsPage
  |     '-- invoke("discover_servers", {timeoutMs}) -> commands::discover_servers
  |
  '-- (Other pages: Dashboard, Chat, Memory, Learning)
        '-- Use connection store -> fetch() to gateway API (not Tauri commands)
```

### 5.2 Registered But Unused Commands

The following Tauri commands are registered in `lib.rs` but never invoked from
any Svelte component:

| Command | Purpose | Status |
|---------|---------|--------|
| `get_platform` | Returns OS and arch | Unused in any .svelte file |
| `get_version` | Returns Cargo.toml version | Unused in any .svelte file |
| `open_external_url` | Opens URL in browser | Unused in any .svelte file |
| `stop_daemon` | Kills daemon process | Only used in window destroy handler (Rust-side) |
| `daemon_running` | Checks if daemon is alive | Unused in any .svelte file |
| `run_bun_script` | Executes arbitrary JS via bun | Unused in any .svelte file |
| `get_config_path` | Returns config file path | Unused in any .svelte file |

### 5.3 The Fatal Flow (Server Onboarding)

```
1. User opens app for first time
2. App.svelte: check_config_exists() -> false
3. App.svelte: appState = "onboarding-role"
4. User clicks "Start as Server"
5. App.svelte: appState = "onboarding-server"
6. ServerSetup: get_os_username() -> pre-fills name (works, pure Rust)
7. User clicks "Connect with Claude"
8. ServerSetup: onboard_setup_server() -> writes config JSON (works, pure Rust)
9. ServerSetup: step = "ready", user clicks "Go to Dashboard"
10. App.svelte: handleOnboardingComplete()
11. App.svelte: get_config_role() -> "server"
12. App.svelte: start_daemon() -> FAILS SILENTLY
    - Command::new("bun") -> bun not found on end-user system
    - Even if bun existed: "packages/cli/src/index.ts" path doesn't exist
    - Error is caught and ignored
13. App.svelte: appState = "running"
14. User sees dashboard, but daemon is not running
15. All API calls to localhost:8419 fail, dashboard shows connection errors
```

---

## 6. Architectural Root Cause

The desktop app was designed as a thin wrapper around the development
environment. It assumes:

1. The monorepo source tree is the working directory
2. Bun is installed globally
3. The CLI can be run directly from TypeScript source

This is fundamentally incompatible with a distributed application. A Tauri
desktop app must be **self-contained**. The daemon functionality needs to be
either:

- **Bundled as a sidecar binary** (Tauri's `externalBin` feature), OR
- **Compiled into the Rust backend** directly, OR
- **Distributed separately** and discovered at runtime via a well-known path

Currently, none of these approaches are implemented.

---

## 7. Recommendations (Not Fixes -- For Future Planning)

1. **Bundle the CLI as a Tauri sidecar** using `externalBin` in tauri.conf.json.
   Compile the CLI to a standalone binary (Bun supports `bun build --compile`).
2. **Add `cargo check` and `cargo test` to CI** on every push/PR.
3. **Add version sync validation** to CI (package.json, Cargo.toml, tauri.conf.json).
4. **Remove `continue-on-error: true`** from desktop builds, or at minimum add
   a separate validation job that MUST pass.
5. **Add smoke tests** that launch the built app and verify basic functionality.
6. **Surface daemon start errors** in the UI instead of catching and ignoring them.
7. **Check for external tool availability** before trying to use them, and show
   clear user-facing messages when tools are missing.
8. **Write Rust unit tests** for all `commands.rs` functions, especially
   path resolution, config operations, and daemon lifecycle.
9. **Generate a real updater signing key** and store it in GitHub Secrets.
10. **Fix the `discover_servers` call** in ClientSetup.svelte to pass the
    required `timeoutMs` parameter.
