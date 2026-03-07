# First-Launch Experience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Eidolon from a disconnected CLI+Desktop into a seamless all-in-one app with 3-screen server onboarding, 2-screen client pairing, and embedded daemon.

**Architecture:** Tauri desktop app embeds Bun subprocess running existing TypeScript daemon. Shared onboarding logic in `packages/core/src/onboarding/` used by both GUI (Tauri commands) and CLI (thin wrapper). Config schema extended with `role` field.

**Tech Stack:** TypeScript/Bun (core logic), Rust/Tauri (desktop shell + system integration), Svelte (GUI), existing packages unchanged.

---

## Phase 1: Bug Fixes (foundation before features)

### Task 1: Fix VERSION constant (V-1/O-2)

**Files:**
- Modify: `packages/protocol/src/constants.ts:8`
- Test: `packages/protocol/src/__tests__/constants.test.ts` (create)

**Step 1: Write failing test**

Create `packages/protocol/src/__tests__/constants.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { VERSION } from "../constants.ts";

describe("VERSION", () => {
  test("is not 0.0.0", () => {
    expect(VERSION).not.toBe("0.0.0");
  });

  test("matches semver pattern", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/__tests__/constants.test.ts`
Expected: FAIL -- VERSION is "0.0.0"

**Step 3: Fix implementation**

In `packages/protocol/src/constants.ts:8`, change:
```typescript
// Before:
export const VERSION = "0.0.0";

// After:
import packageJson from "../package.json";
export const VERSION: string = packageJson.version;
```

Verify `packages/protocol/package.json` has `"version"` field (it does, managed by release-please). Add `"resolveJsonModule": true` to protocol tsconfig if not already present.

**Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/src/__tests__/constants.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/protocol/src/constants.ts packages/protocol/src/__tests__/constants.test.ts
git commit -m "fix(protocol): read VERSION from package.json instead of hardcoded 0.0.0"
```

---

### Task 2: Fix --config flag (O-1/D-1)

**Files:**
- Modify: `packages/cli/src/commands/daemon.ts:159`

**Step 1: Write failing test**

This is a one-line fix with existing integration. Verify by reading the code:

In `packages/cli/src/commands/daemon.ts`, find `startForeground`:
```typescript
// Line ~159: currently:
const daemon = new EidolonDaemon();
// Should be:
const daemon = new EidolonDaemon({ configPath: _configPath });
```

**Step 2: Apply fix**

Change line ~159 in `packages/cli/src/commands/daemon.ts`:
```typescript
const daemon = new EidolonDaemon(_configPath ? { configPath: _configPath } : undefined);
```

`DaemonOptions` already has `configPath?: string` (in `packages/core/src/daemon/types.ts`).
`loadConfig()` already accepts a path arg (in `packages/core/src/config/loader.ts:17`).

**Step 3: Verify typecheck**

Run: `pnpm --filter @eidolon-ai/cli typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/cli/src/commands/daemon.ts
git commit -m "fix(cli): pass --config path through to EidolonDaemon"
```

---

### Task 3: Fix CSP and TLS defaults (A-4, A-5, A-6)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json` -- CSP
- Modify: `apps/desktop/src/lib/stores/settings.ts:39` -- TLS default

**Step 1: Fix CSP**

In `apps/desktop/src-tauri/tauri.conf.json`, find the `security.csp` field and change to:
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* wss://localhost:* ws://127.0.0.1:* wss://127.0.0.1:* http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:* ws://*.ts.net:* wss://*.ts.net:* http://*.ts.net:* https://*.ts.net:*; img-src 'self' data: asset: http://asset.localhost"
```

**Step 2: Fix TLS default**

In `apps/desktop/src/lib/stores/settings.ts:39`, change:
```typescript
// Before:
useTls: true,
// After:
useTls: false,
```

**Step 3: Verify build**

Run: `pnpm --filter @eidolon/desktop build`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/src/lib/stores/settings.ts
git commit -m "fix(desktop): allow ws:// and Tailscale connections, default TLS off"
```

---

### Task 4: Fix hardcoded sidebar version (A-3/V-3)

**Files:**
- Modify: `apps/desktop/src/routes/+layout.svelte:68`

**Step 1: Fix version display**

In `apps/desktop/src/routes/+layout.svelte`, find `<span class="version">v0.1.0</span>` (~line 68).

Replace the hardcoded version with a reactive store value. Add to the `<script>` section:
```typescript
import { getVersion } from "@tauri-apps/api/app";
import { onMount } from "svelte";

let appVersion = "";
onMount(async () => {
  try {
    appVersion = await getVersion();
  } catch {
    appVersion = "dev";
  }
});
```

Replace in template:
```svelte
<span class="version">v{appVersion}</span>
```

**Step 2: Verify build**

Run: `pnpm --filter @eidolon/desktop build`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/desktop/src/routes/+layout.svelte
git commit -m "fix(desktop): read version from Tauri API instead of hardcoded value"
```

---

### Task 5: Fix daemon "no config" error message (D-2)

**Files:**
- Modify: `packages/core/src/daemon/init-foundation.ts:45-55`

**Step 1: Improve error message**

In `init-foundation.ts`, find the config loading step. When `loadConfig` returns an error, the message should suggest running onboarding:

```typescript
if (!configResult.ok) {
  const msg = configResult.error.message.includes("not found")
    ? `${configResult.error.message}\n\nRun 'eidolon onboard' to set up your configuration, or use --config <path> to specify a config file.`
    : configResult.error.message;
  throw new Error(msg);
}
```

**Step 2: Commit**

```bash
git add packages/core/src/daemon/init-foundation.ts
git commit -m "fix(core): show helpful message when config file not found"
```

---

### Task 6: Fix gateway auth default catch-22 (C-1)

**Files:**
- Modify: `packages/protocol/src/config-channels.ts` -- gateway auth schema

**Step 1: Change auth default**

Find the `GatewayAuthSchema` and change the default `type` from `"token"` to `"none"`:
```typescript
// Before:
type: z.enum(["none", "token"]).default("token"),
// After:
type: z.enum(["none", "token"]).default("none"),
```

This means a minimal config without auth settings will work out of the box. The onboarding wizard generates a token and sets `type: "token"` explicitly.

**Step 2: Run existing tests**

Run: `bun test packages/protocol/src/__tests__/config.test.ts`
Verify existing tests still pass. Update any test that expects default auth type to be "token".

**Step 3: Commit**

```bash
git add packages/protocol/src/config-channels.ts packages/protocol/src/__tests__/config.test.ts
git commit -m "fix(protocol): default gateway auth to 'none' to avoid catch-22"
```

---

### Task 7: Sync Tauri version with manifest (V-2)

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json` -- version field
- Modify: `release-please-config.json` -- add extra-files for tauri.conf.json

**Step 1: Update version**

In `apps/desktop/src-tauri/tauri.conf.json`, update `version` to match `.release-please-manifest.json` value for `apps/desktop`.

**Step 2: Add to release-please extra-files**

In `release-please-config.json`, for the `apps/desktop` package entry, add:
```json
"extra-files": [
  {
    "type": "json",
    "path": "src-tauri/tauri.conf.json",
    "jsonpath": "$.version"
  }
]
```

This ensures release-please bumps the Tauri version on every release.

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/tauri.conf.json release-please-config.json
git commit -m "fix(desktop): sync tauri.conf.json version with release-please"
```

---

## Phase 2: Config Schema Extension

### Task 8: Add role field to config schema

**Files:**
- Modify: `packages/protocol/src/config.ts` -- add role field
- Modify: `packages/protocol/src/config.ts` -- add client server block
- Test: `packages/protocol/src/__tests__/config.test.ts`

**Step 1: Write failing test**

Add to `packages/protocol/src/__tests__/config.test.ts`:
```typescript
describe("Role field", () => {
  test("defaults to server", () => {
    const result = EidolonConfigSchema.parse(validConfig);
    expect(result.role).toBe("server");
  });

  test("accepts client role with server block", () => {
    const clientConfig = {
      ...minimalConfig,
      role: "client",
      server: { host: "100.64.0.1", port: 8419, token: "abc123" },
    };
    const result = EidolonConfigSchema.parse(clientConfig);
    expect(result.role).toBe("client");
    expect(result.server?.host).toBe("100.64.0.1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/__tests__/config.test.ts`
Expected: FAIL -- role field not in schema

**Step 3: Add to schema**

In `packages/protocol/src/config.ts`, add to `EidolonConfigSchema`:
```typescript
role: z.enum(["server", "client"]).default("server"),
server: z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  token: z.string().optional(),
  tls: z.boolean().default(false),
}).optional(),
```

Export the type:
```typescript
export type EidolonRole = "server" | "client";
```

**Step 4: Run tests**

Run: `bun test packages/protocol/src/__tests__/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/__tests__/config.test.ts
git commit -m "feat(protocol): add role and server fields to config schema"
```

---

## Phase 3: Shared Onboarding Logic

### Task 9: Create onboarding module -- setup-checks

**Files:**
- Create: `packages/core/src/onboarding/setup-checks.ts`
- Create: `packages/core/src/onboarding/__tests__/setup-checks.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { runPreflightChecks } from "../setup-checks.ts";

describe("runPreflightChecks", () => {
  test("returns ok with all checks passed", () => {
    const result = runPreflightChecks();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.bunVersion).toBeTruthy();
      expect(result.value.diskSpaceMb).toBeGreaterThan(0);
    }
  });

  test("check results include required fields", () => {
    const result = runPreflightChecks();
    if (result.ok) {
      expect(result.value).toHaveProperty("bunVersion");
      expect(result.value).toHaveProperty("diskSpaceMb");
      expect(result.value).toHaveProperty("dataDir");
      expect(result.value).toHaveProperty("configDir");
    }
  });
});
```

**Step 2: Implement**

```typescript
import { Ok, Err, type Result, type EidolonError, createError, ErrorCode } from "@eidolon/protocol";
import { getDataDir, getConfigDir } from "../config/paths.ts";
import { mkdirSync, statfsSync } from "node:fs";

export interface PreflightResult {
  readonly bunVersion: string;
  readonly diskSpaceMb: number;
  readonly dataDir: string;
  readonly configDir: string;
}

export function runPreflightChecks(): Result<PreflightResult, EidolonError> {
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : "unknown";
  const dataDir = getDataDir();
  const configDir = getConfigDir();

  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    return Err(createError(ErrorCode.IO_ERROR, `Failed to create directories: ${cause}`, cause));
  }

  let diskSpaceMb = 0;
  try {
    const stats = statfsSync(dataDir);
    diskSpaceMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    // Non-fatal, disk space check is best-effort
  }

  if (diskSpaceMb > 0 && diskSpaceMb < 500) {
    return Err(createError(ErrorCode.VALIDATION_ERROR, `Insufficient disk space: ${diskSpaceMb}MB (need 500MB)`));
  }

  return Ok({ bunVersion, diskSpaceMb, dataDir, configDir });
}
```

**Step 3: Run test, verify passes**

Run: `bun test packages/core/src/onboarding/__tests__/setup-checks.test.ts`

**Step 4: Commit**

```bash
git add packages/core/src/onboarding/
git commit -m "feat(core): add onboarding setup-checks module"
```

---

### Task 10: Create onboarding module -- setup-identity

**Files:**
- Create: `packages/core/src/onboarding/setup-identity.ts`
- Create: `packages/core/src/onboarding/__tests__/setup-identity.test.ts`

**Step 1: Write test**

```typescript
import { describe, expect, test } from "bun:test";
import { generateMasterKey, getDefaultOwnerName } from "../setup-identity.ts";

describe("setup-identity", () => {
  test("getDefaultOwnerName returns a non-empty string", () => {
    const name = getDefaultOwnerName();
    expect(name.length).toBeGreaterThan(0);
  });

  test("generateMasterKey returns a 64-char hex string", () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

**Step 2: Implement**

```typescript
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";

export function getDefaultOwnerName(): string {
  try {
    return userInfo().username;
  } catch {
    return "User";
  }
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("hex");
}
```

**Step 3: Run test, commit**

```bash
bun test packages/core/src/onboarding/__tests__/setup-identity.test.ts
git add packages/core/src/onboarding/
git commit -m "feat(core): add onboarding setup-identity module"
```

---

### Task 11: Create onboarding module -- setup-network

**Files:**
- Create: `packages/core/src/onboarding/setup-network.ts`
- Create: `packages/core/src/onboarding/__tests__/setup-network.test.ts`

**Step 1: Write test**

```typescript
import { describe, expect, test } from "bun:test";
import { detectTailscale, generateAuthToken, buildGatewayConfig } from "../setup-network.ts";

describe("setup-network", () => {
  test("generateAuthToken returns a 64-char hex token", () => {
    const token = generateAuthToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  test("buildGatewayConfig returns valid gateway config", () => {
    const config = buildGatewayConfig({ port: 8419, token: "abc", tailscaleIp: undefined });
    expect(config.port).toBe(8419);
    expect(config.auth.type).toBe("token");
    expect(config.auth.token).toBe("abc");
    expect(config.host).toBe("127.0.0.1");
  });

  test("buildGatewayConfig binds to 0.0.0.0 when Tailscale detected", () => {
    const config = buildGatewayConfig({ port: 8419, token: "abc", tailscaleIp: "100.64.0.1" });
    expect(config.host).toBe("0.0.0.0");
  });

  test("detectTailscale returns ip or null", async () => {
    const result = await detectTailscale();
    // Can be null if Tailscale not installed -- test shape only
    expect(result === null || typeof result === "string").toBe(true);
  });
});
```

**Step 2: Implement**

```typescript
import { randomBytes } from "node:crypto";

export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

export interface GatewayBuildOptions {
  readonly port: number;
  readonly token: string;
  readonly tailscaleIp: string | undefined;
}

export function buildGatewayConfig(options: GatewayBuildOptions) {
  return {
    port: options.port,
    host: options.tailscaleIp ? "0.0.0.0" : "127.0.0.1",
    auth: { type: "token" as const, token: options.token },
    tls: { enabled: false },
    discovery: { enabled: !!options.tailscaleIp, port: 41920 },
  };
}

export async function detectTailscale(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    const ip = output.trim().split("\n")[0]?.trim();
    return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}
```

**Step 3: Run test, commit**

```bash
bun test packages/core/src/onboarding/__tests__/setup-network.test.ts
git add packages/core/src/onboarding/
git commit -m "feat(core): add onboarding setup-network module"
```

---

### Task 12: Create onboarding module -- setup-database

**Files:**
- Create: `packages/core/src/onboarding/setup-database.ts`
- Create: `packages/core/src/onboarding/__tests__/setup-database.test.ts`

**Step 1: Write test**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabases } from "../setup-database.ts";

describe("initializeDatabases", () => {
  test("creates 3 databases in target directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-test-"));
    const result = initializeDatabases(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.memoryTables).toBeGreaterThan(0);
      expect(result.value.operationalTables).toBeGreaterThan(0);
      expect(result.value.auditTables).toBeGreaterThan(0);
    }
  });
});
```

**Step 2: Implement**

Wraps existing `DatabaseManager.initialize()` from `@eidolon/core`:
```typescript
import type { Result, EidolonError } from "@eidolon/protocol";
import { Ok, Err, createError, ErrorCode } from "@eidolon/protocol";
import { DatabaseManager, createLogger } from "../index.ts";

export interface DbInitResult {
  readonly memoryTables: number;
  readonly operationalTables: number;
  readonly auditTables: number;
}

export function initializeDatabases(directory: string): Result<DbInitResult, EidolonError> {
  const logger = createLogger({ level: "warn", format: "pretty", directory: "", maxSizeMb: 50, maxFiles: 10 });
  const dbConfig = { directory, walMode: true, backupSchedule: "0 3 * * *" };

  try {
    const db = new DatabaseManager(dbConfig, logger);
    const initResult = db.initialize();
    if (!initResult.ok) return initResult;

    const countTables = (dbInstance: { query: (sql: string) => { all: () => unknown[] } }) =>
      (dbInstance.query("SELECT count(*) as c FROM sqlite_master WHERE type='table'").all()[0] as { c: number }).c;

    const result: DbInitResult = {
      memoryTables: countTables(db.memory),
      operationalTables: countTables(db.operational),
      auditTables: countTables(db.audit),
    };

    db.close();
    return Ok(result);
  } catch (cause) {
    return Err(createError(ErrorCode.DATABASE_ERROR, `Database init failed: ${cause}`, cause));
  }
}
```

**Step 3: Run test, commit**

```bash
bun test packages/core/src/onboarding/__tests__/setup-database.test.ts
git add packages/core/src/onboarding/
git commit -m "feat(core): add onboarding setup-database module"
```

---

### Task 13: Create onboarding module -- setup-finalize

**Files:**
- Create: `packages/core/src/onboarding/setup-finalize.ts`
- Create: `packages/core/src/onboarding/__tests__/setup-finalize.test.ts`
- Create: `packages/core/src/onboarding/index.ts` -- barrel export

**Step 1: Write test**

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServerConfig, writeConfig } from "../setup-finalize.ts";

describe("setup-finalize", () => {
  test("buildServerConfig produces valid minimal config", () => {
    const config = buildServerConfig({
      ownerName: "Test",
      claudeCredential: { type: "oauth", name: "primary", credential: "oauth" },
      gateway: { port: 8419, host: "127.0.0.1", auth: { type: "none" }, tls: { enabled: false }, discovery: { enabled: false, port: 41920 } },
      dataDir: "/tmp/test",
    });
    expect(config.identity.ownerName).toBe("Test");
    expect(config.role).toBe("server");
    expect(config.brain.accounts.length).toBe(1);
  });

  test("writeConfig writes JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-cfg-"));
    const path = join(dir, "eidolon.json");
    const result = writeConfig(path, { test: true });
    expect(result.ok).toBe(true);
    const content = JSON.parse(readFileSync(path, "utf-8"));
    expect(content.test).toBe(true);
  });
});
```

**Step 2: Implement setup-finalize.ts**

Builds a complete `EidolonConfig` from onboarding inputs and writes it:
```typescript
import type { Result, EidolonError } from "@eidolon/protocol";
import { Ok, Err, createError, ErrorCode } from "@eidolon/protocol";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ServerConfigInput {
  readonly ownerName: string;
  readonly claudeCredential: { type: string; name: string; credential: string };
  readonly gateway: Record<string, unknown>;
  readonly dataDir: string;
}

export function buildServerConfig(input: ServerConfigInput): Record<string, unknown> {
  return {
    role: "server",
    identity: { name: "Eidolon", ownerName: input.ownerName },
    brain: {
      accounts: [input.claudeCredential],
      model: {},
      session: {},
    },
    loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
    memory: { extraction: {}, dreaming: {}, search: {}, embedding: {}, retention: {}, entityResolution: {} },
    learning: { relevance: {}, autoImplement: {}, budget: {} },
    channels: {},
    gateway: input.gateway,
    gpu: { tts: {}, stt: {}, fallback: {} },
    security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
    database: { directory: input.dataDir },
    logging: {},
    daemon: {},
  };
}

export function buildClientConfig(server: { host: string; port: number; token?: string; tls?: boolean }): Record<string, unknown> {
  return {
    role: "client",
    server: { host: server.host, port: server.port, token: server.token, tls: server.tls ?? false },
    identity: { name: "Eidolon", ownerName: "Client" },
    brain: { accounts: [{ type: "oauth", name: "primary", credential: "oauth" }], model: {}, session: {} },
    loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
    memory: { extraction: {}, dreaming: {}, search: {}, embedding: {}, retention: {}, entityResolution: {} },
    learning: { relevance: {}, autoImplement: {}, budget: {} },
    channels: {},
    gateway: { auth: { type: "none" } },
    gpu: { tts: {}, stt: {}, fallback: {} },
    security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
    database: {},
    logging: {},
    daemon: {},
  };
}

export function writeConfig(path: string, config: Record<string, unknown>): Result<void, EidolonError> {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    return Ok(undefined);
  } catch (cause) {
    return Err(createError(ErrorCode.IO_ERROR, `Failed to write config: ${cause}`, cause));
  }
}
```

**Step 3: Create index.ts barrel**

```typescript
export { runPreflightChecks, type PreflightResult } from "./setup-checks.ts";
export { getDefaultOwnerName, generateMasterKey } from "./setup-identity.ts";
export { detectTailscale, generateAuthToken, buildGatewayConfig, type GatewayBuildOptions } from "./setup-network.ts";
export { initializeDatabases, type DbInitResult } from "./setup-database.ts";
export { buildServerConfig, buildClientConfig, writeConfig, type ServerConfigInput } from "./setup-finalize.ts";
```

**Step 4: Run all onboarding tests**

Run: `bun test packages/core/src/onboarding/`
Expected: all pass

**Step 5: Commit**

```bash
git add packages/core/src/onboarding/
git commit -m "feat(core): add onboarding setup-finalize and barrel export"
```

---

## Phase 4: Tauri Daemon Management

### Task 14: Add Tauri commands for daemon lifecycle

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` -- add commands
- Modify: `apps/desktop/src-tauri/Cargo.toml` -- add serde_json if needed

**Step 1: Add daemon management commands to lib.rs**

Add Tauri commands that spawn/stop a Bun subprocess:
```rust
use std::sync::Mutex;
use std::process::{Child, Command};
use tauri::State;

struct DaemonState(Mutex<Option<Child>>);

#[tauri::command]
fn start_daemon(state: State<DaemonState>, config_path: String) -> Result<u32, String> {
    let mut daemon = state.0.lock().map_err(|e| e.to_string())?;
    if daemon.is_some() {
        return Err("Daemon already running".into());
    }

    let child = Command::new("bun")
        .args(["run", "packages/cli/src/index.ts", "daemon", "start", "--foreground", "--config", &config_path])
        .spawn()
        .map_err(|e| format!("Failed to start daemon: {}", e))?;

    let pid = child.id();
    *daemon = Some(child);
    Ok(pid)
}

#[tauri::command]
fn stop_daemon(state: State<DaemonState>) -> Result<(), String> {
    let mut daemon = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = daemon.take() {
        child.kill().map_err(|e| format!("Failed to stop daemon: {}", e))?;
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
fn daemon_running(state: State<DaemonState>) -> bool {
    let daemon = state.0.lock().unwrap_or_else(|e| e.into_inner());
    daemon.is_some()
}
```

Update the `run()` function to register state and commands:
```rust
.manage(DaemonState(Mutex::new(None)))
.invoke_handler(tauri::generate_handler![
    discover_servers,
    start_daemon,
    stop_daemon,
    daemon_running,
])
```

Add `on_exit` handler to stop daemon when app closes:
```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::Destroyed = event {
        if let Some(state) = window.try_state::<DaemonState>() {
            if let Ok(mut daemon) = state.0.lock() {
                if let Some(mut child) = daemon.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
})
```

**Step 2: Verify Rust compiles**

Run: `cd apps/desktop && pnpm tauri build --debug 2>&1 | head -20`
Or just check: `cd apps/desktop/src-tauri && cargo check`

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/
git commit -m "feat(desktop): add Tauri commands for embedded daemon lifecycle"
```

---

### Task 15: Add Tauri commands for onboarding

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Step 1: Add onboarding commands**

These commands invoke the shared TypeScript onboarding modules via Bun subprocess:
```rust
#[tauri::command]
async fn onboard_preflight() -> Result<String, String> {
    let output = Command::new("bun")
        .args(["run", "-e", "import { runPreflightChecks } from '@eidolon/core'; const r = runPreflightChecks(); console.log(JSON.stringify(r))"])
        .output()
        .map_err(|e| e.to_string())?;
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
async fn onboard_detect_tailscale() -> Result<String, String> {
    let output = Command::new("bun")
        .args(["run", "-e", "import { detectTailscale } from '@eidolon/core'; detectTailscale().then(ip => console.log(JSON.stringify(ip)))"])
        .output()
        .map_err(|e| e.to_string())?;
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
async fn onboard_setup_server(name: String, credential_type: String, api_key: Option<String>) -> Result<String, String> {
    // Calls a dedicated onboarding entry point script
    let script = format!(
        r#"
        import {{ getDefaultOwnerName, generateMasterKey, generateAuthToken, detectTailscale, buildGatewayConfig, initializeDatabases, buildServerConfig, writeConfig }} from '@eidolon/core';
        import {{ getDataDir, getConfigPath }} from '@eidolon/core';
        const masterKey = generateMasterKey();
        const token = generateAuthToken();
        const tailscaleIp = await detectTailscale();
        const gateway = buildGatewayConfig({{ port: 8419, token, tailscaleIp }});
        const dataDir = getDataDir();
        const dbResult = initializeDatabases(dataDir);
        const credential = {{ type: '{}', name: 'primary', credential: '{}' }};
        const config = buildServerConfig({{ ownerName: '{}', claudeCredential: credential, gateway, dataDir }});
        const configPath = getConfigPath();
        writeConfig(configPath, config);
        console.log(JSON.stringify({{ ok: true, configPath, tailscaleIp, token, masterKey }}));
        "#,
        credential_type,
        api_key.unwrap_or_else(|| "oauth".to_string()),
        name
    );

    let output = Command::new("bun")
        .args(["run", "-e", &script])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Setup failed: {}", stderr));
    }

    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_config_exists() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let config_path = if cfg!(target_os = "macos") {
        format!("{}/Library/Preferences/eidolon/eidolon.json", home)
    } else if cfg!(target_os = "windows") {
        format!("{}/AppData/Roaming/eidolon/config/eidolon.json", std::env::var("APPDATA").unwrap_or_default())
    } else {
        format!("{}/.config/eidolon/eidolon.json", home)
    };
    std::path::Path::new(&config_path).exists()
}

#[tauri::command]
async fn get_config_role() -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let config_path = if cfg!(target_os = "macos") {
        format!("{}/Library/Preferences/eidolon/eidolon.json", home)
    } else if cfg!(target_os = "windows") {
        format!("{}/AppData/Roaming/eidolon/config/eidolon.json", std::env::var("APPDATA").unwrap_or_default())
    } else {
        format!("{}/.config/eidolon/eidolon.json", home)
    };

    let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(json.get("role").and_then(|v| v.as_str()).unwrap_or("server").to_string())
}
```

Register all new commands in `invoke_handler`.

**Step 2: Verify compilation**

Run: `cd apps/desktop/src-tauri && cargo check`

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/
git commit -m "feat(desktop): add Tauri commands for onboarding and config detection"
```

---

## Phase 5: Desktop Onboarding UI

### Task 16: Create role selection screen

**Files:**
- Create: `apps/desktop/src/routes/onboarding/RoleSelect.svelte`
- Modify: `apps/desktop/src/App.svelte` -- add onboarding route

**Step 1: Create RoleSelect component**

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher<{ select: "server" | "client" }>();
</script>

<div class="onboarding-container">
  <div class="logo-section">
    <h1>Eidolon</h1>
    <p class="subtitle">Your autonomous AI assistant</p>
  </div>

  <div class="role-cards">
    <button class="role-card" on:click={() => dispatch("select", "server")}>
      <span class="role-icon">&#x1F9E0;</span>
      <h2>Start as Server</h2>
      <p>Run your own AI brain on this machine</p>
    </button>

    <button class="role-card" on:click={() => dispatch("select", "client")}>
      <span class="role-icon">&#x1F4F1;</span>
      <h2>Connect as Client</h2>
      <p>Connect to an existing Eidolon server</p>
    </button>
  </div>
</div>

<style>
  .onboarding-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 3rem;
    background: var(--bg-primary, #0a0e1a);
    color: var(--text-primary, #e0e0e0);
  }

  .logo-section { text-align: center; }
  .logo-section h1 { font-size: 2.5rem; margin: 0; color: var(--accent, #4a9eff); }
  .subtitle { color: var(--text-secondary, #888); margin-top: 0.5rem; }

  .role-cards { display: flex; gap: 1.5rem; }

  .role-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 2rem 2.5rem;
    border: 2px solid var(--border, #1a2035);
    border-radius: 12px;
    background: var(--bg-secondary, #0f1525);
    cursor: pointer;
    transition: border-color 0.2s, transform 0.2s;
    color: inherit;
    font-family: inherit;
    min-width: 220px;
  }

  .role-card:hover {
    border-color: var(--accent, #4a9eff);
    transform: translateY(-2px);
  }

  .role-card h2 { margin: 0; font-size: 1.2rem; }
  .role-card p { margin: 0; color: var(--text-secondary, #888); font-size: 0.9rem; }
  .role-icon { font-size: 2rem; }
</style>
```

**Step 2: Update App.svelte routing**

In `apps/desktop/src/App.svelte`, add onboarding state detection:
```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import RoleSelect from "./routes/onboarding/RoleSelect.svelte";
  import ServerSetup from "./routes/onboarding/ServerSetup.svelte";
  import ClientSetup from "./routes/onboarding/ClientSetup.svelte";
  // ... existing imports

  let appState: "loading" | "onboarding-role" | "onboarding-server" | "onboarding-client" | "running" = "loading";

  onMount(async () => {
    const hasConfig = await invoke<boolean>("check_config_exists");
    if (!hasConfig) {
      appState = "onboarding-role";
    } else {
      const role = await invoke<string>("get_config_role");
      if (role === "server") {
        await invoke("start_daemon", { configPath: "" }); // uses default path
      }
      appState = "running";
    }
  });

  function handleRoleSelect(event: CustomEvent<"server" | "client">) {
    appState = event.detail === "server" ? "onboarding-server" : "onboarding-client";
  }

  function handleSetupComplete() {
    appState = "running";
  }
</script>

{#if appState === "loading"}
  <div class="loading">Loading...</div>
{:else if appState === "onboarding-role"}
  <RoleSelect on:select={handleRoleSelect} />
{:else if appState === "onboarding-server"}
  <ServerSetup on:complete={handleSetupComplete} />
{:else if appState === "onboarding-client"}
  <ClientSetup on:complete={handleSetupComplete} />
{:else}
  <!-- existing app layout with sidebar + routes -->
{/if}
```

**Step 3: Verify build**

Run: `pnpm --filter @eidolon/desktop build`

**Step 4: Commit**

```bash
git add apps/desktop/src/
git commit -m "feat(desktop): add role selection onboarding screen"
```

---

### Task 17: Create server setup screens

**Files:**
- Create: `apps/desktop/src/routes/onboarding/ServerSetup.svelte`

3-screen flow: Name+Claude -> Auto-setup -> Ready!

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-shell";

  const dispatch = createEventDispatcher<{ complete: void }>();

  let step: "identity" | "setup" | "ready" = "identity";
  let name = "";
  let credentialType = "oauth";
  let apiKey = "";
  let setupSteps: Array<{ label: string; status: "pending" | "done" | "error" }> = [];
  let pairingUrl = "";
  let error = "";

  // Pre-fill name from OS
  invoke<string>("get_os_username").then(n => { name = n; }).catch(() => {});

  async function startOAuth() {
    await open("https://claude.ai/login"); // OAuth flow
    credentialType = "oauth";
    startSetup();
  }

  function useApiKey() {
    if (!apiKey.trim()) { error = "API key required"; return; }
    credentialType = "api_key";
    startSetup();
  }

  async function startSetup() {
    if (!name.trim()) { error = "Name required"; return; }
    error = "";
    step = "setup";

    setupSteps = [
      { label: "Generating master key", status: "pending" },
      { label: "Initializing secret store", status: "pending" },
      { label: "Creating databases", status: "pending" },
      { label: "Configuring network", status: "pending" },
      { label: "Installing CLI", status: "pending" },
    ];

    // Simulate step-by-step progress while the actual setup runs
    const progressInterval = setInterval(() => {
      const nextPending = setupSteps.findIndex(s => s.status === "pending");
      if (nextPending >= 0) {
        setupSteps[nextPending].status = "done";
        setupSteps = setupSteps; // trigger reactivity
      }
    }, 600);

    try {
      const resultJson = await invoke<string>("onboard_setup_server", {
        name: name.trim(),
        credentialType,
        apiKey: credentialType === "api_key" ? apiKey.trim() : null,
      });

      clearInterval(progressInterval);
      setupSteps = setupSteps.map(s => ({ ...s, status: "done" }));

      const result = JSON.parse(resultJson);
      if (result.ok) {
        pairingUrl = `eidolon://${result.tailscaleIp || "localhost"}:8419?token=${result.token}`;
        // Start the daemon
        await invoke("start_daemon", { configPath: result.configPath });
        step = "ready";
      } else {
        error = result.error || "Setup failed";
      }
    } catch (e) {
      clearInterval(progressInterval);
      error = String(e);
    }
  }
</script>

{#if step === "identity"}
  <div class="onboarding-container">
    <h1>Set up your server</h1>

    <div class="form-group">
      <label for="name">Your name</label>
      <input id="name" type="text" bind:value={name} placeholder="Your name" />
    </div>

    <div class="actions">
      <button class="primary" on:click={startOAuth}>Connect with Claude</button>
      <details class="advanced">
        <summary>Use API key instead</summary>
        <div class="form-group">
          <input type="password" bind:value={apiKey} placeholder="sk-ant-..." />
          <button on:click={useApiKey}>Continue with API key</button>
        </div>
      </details>
    </div>

    {#if error}<p class="error">{error}</p>{/if}
  </div>

{:else if step === "setup"}
  <div class="onboarding-container">
    <h1>Setting up...</h1>
    <div class="setup-steps">
      {#each setupSteps as s}
        <div class="step" class:done={s.status === "done"}>
          <span class="check">{s.status === "done" ? "OK" : "..."}</span>
          {s.label}
        </div>
      {/each}
    </div>
    {#if error}<p class="error">{error}</p>{/if}
  </div>

{:else if step === "ready"}
  <div class="onboarding-container">
    <h1>Eidolon is ready!</h1>
    <p class="success-text">Your AI assistant is running.</p>

    <div class="pairing-section">
      <h3>Connect other devices</h3>
      <code class="pairing-url">{pairingUrl}</code>
      <p class="hint">Paste this URL on your other devices, or scan the QR code.</p>
    </div>

    <button class="primary" on:click={() => dispatch("complete")}>Go to Dashboard</button>
  </div>
{/if}

<style>
  .onboarding-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 1.5rem;
    padding: 2rem;
    background: var(--bg-primary, #0a0e1a);
    color: var(--text-primary, #e0e0e0);
  }

  h1 { color: var(--accent, #4a9eff); margin: 0; }
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; width: 300px; }
  .form-group label { font-size: 0.9rem; color: var(--text-secondary, #888); }
  .form-group input {
    padding: 0.75rem;
    border: 1px solid var(--border, #1a2035);
    border-radius: 8px;
    background: var(--bg-secondary, #0f1525);
    color: inherit;
    font-size: 1rem;
  }

  .primary {
    padding: 0.75rem 2rem;
    background: var(--accent, #4a9eff);
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 600;
  }
  .primary:hover { opacity: 0.9; }

  .actions { display: flex; flex-direction: column; gap: 1rem; align-items: center; }
  .advanced { color: var(--text-secondary, #888); font-size: 0.85rem; cursor: pointer; }
  .advanced summary { cursor: pointer; }

  .setup-steps { display: flex; flex-direction: column; gap: 0.75rem; min-width: 300px; }
  .step { padding: 0.5rem; opacity: 0.5; transition: opacity 0.3s; }
  .step.done { opacity: 1; }
  .check { margin-right: 0.75rem; }

  .error { color: #ff4444; }
  .success-text { color: #44ff88; font-size: 1.1rem; }

  .pairing-section {
    text-align: center;
    padding: 1.5rem;
    border: 1px solid var(--border, #1a2035);
    border-radius: 12px;
    background: var(--bg-secondary, #0f1525);
  }
  .pairing-section h3 { margin: 0 0 0.5rem; }
  .pairing-url {
    display: block;
    padding: 0.75rem;
    background: var(--bg-primary, #0a0e1a);
    border-radius: 6px;
    font-size: 0.85rem;
    word-break: break-all;
    margin: 0.5rem 0;
  }
  .hint { color: var(--text-secondary, #888); font-size: 0.8rem; margin: 0; }
</style>
```

**Step 2: Verify build, commit**

```bash
pnpm --filter @eidolon/desktop build
git add apps/desktop/src/routes/onboarding/
git commit -m "feat(desktop): add server setup onboarding screens"
```

---

### Task 18: Create client setup screens

**Files:**
- Create: `apps/desktop/src/routes/onboarding/ClientSetup.svelte`

2-screen flow: Find Server -> Connected!

```svelte
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";

  const dispatch = createEventDispatcher<{ complete: void }>();

  interface DiscoveredServer {
    name: string;
    host: string;
    port: number;
    version: string;
  }

  let step: "discover" | "connected" = "discover";
  let servers: DiscoveredServer[] = [];
  let scanning = true;
  let pairingInput = "";
  let manualHost = "";
  let manualPort = "8419";
  let manualToken = "";
  let error = "";
  let connectedServer = "";

  onMount(async () => {
    // Run discovery in parallel
    try {
      const result = await invoke<string>("discover_servers");
      servers = JSON.parse(result);
    } catch { /* no servers found */ }
    scanning = false;
  });

  async function selectServer(server: DiscoveredServer) {
    await connectTo(server.host, server.port, "");
  }

  function parsePairingUrl(url: string): { host: string; port: number; token: string } | null {
    try {
      const parsed = new URL(url.replace("eidolon://", "https://"));
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || "8419"),
        token: parsed.searchParams.get("token") || "",
      };
    } catch { return null; }
  }

  async function usePairingUrl() {
    const parsed = parsePairingUrl(pairingInput.trim());
    if (!parsed) { error = "Invalid pairing URL"; return; }
    await connectTo(parsed.host, parsed.port, parsed.token);
  }

  async function connectManual() {
    await connectTo(manualHost.trim(), parseInt(manualPort), manualToken.trim());
  }

  async function connectTo(host: string, port: number, token: string) {
    error = "";
    try {
      // Test connection via health endpoint
      const response = await fetch(`http://${host}:${port}/health`);
      if (!response.ok) throw new Error("Server not reachable");

      // Write client config
      const script = `
        import { buildClientConfig, writeConfig } from '@eidolon/core';
        import { getConfigPath } from '@eidolon/core';
        const config = buildClientConfig({ host: '${host}', port: ${port}, token: '${token}', tls: false });
        const path = getConfigPath();
        writeConfig(path, config);
        console.log(JSON.stringify({ ok: true }));
      `;
      await invoke<string>("run_bun_script", { script });

      connectedServer = `${host}:${port}`;
      step = "connected";
    } catch (e) {
      error = `Cannot connect: ${e}`;
    }
  }
</script>

{#if step === "discover"}
  <div class="onboarding-container">
    <h1>Find your server</h1>

    {#if scanning}
      <p class="scanning">Scanning network...</p>
    {:else if servers.length > 0}
      <div class="server-list">
        {#each servers as server}
          <button class="server-card" on:click={() => selectServer(server)}>
            <strong>{server.name}</strong>
            <span class="server-ip">{server.host}:{server.port}</span>
          </button>
        {/each}
      </div>
    {:else}
      <p class="no-servers">No servers found on your network.</p>
    {/if}

    <div class="divider">or</div>

    <div class="form-group">
      <label>Paste pairing URL</label>
      <input type="text" bind:value={pairingInput} placeholder="eidolon://host:port?token=..." />
      <button class="primary" on:click={usePairingUrl}>Connect</button>
    </div>

    <details class="advanced">
      <summary>Manual connection</summary>
      <div class="manual-form">
        <input type="text" bind:value={manualHost} placeholder="Host (IP or hostname)" />
        <input type="text" bind:value={manualPort} placeholder="Port (8419)" />
        <input type="password" bind:value={manualToken} placeholder="Auth token (optional)" />
        <button on:click={connectManual}>Connect</button>
      </div>
    </details>

    {#if error}<p class="error">{error}</p>{/if}
  </div>

{:else if step === "connected"}
  <div class="onboarding-container">
    <h1>Connected!</h1>
    <p class="success-text">Connected to {connectedServer}</p>
    <button class="primary" on:click={() => dispatch("complete")}>Go to Dashboard</button>
  </div>
{/if}

<style>
  .onboarding-container {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 100vh; gap: 1.5rem;
    padding: 2rem; background: var(--bg-primary, #0a0e1a);
    color: var(--text-primary, #e0e0e0);
  }
  h1 { color: var(--accent, #4a9eff); margin: 0; }
  .scanning { color: var(--text-secondary); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .server-list { display: flex; flex-direction: column; gap: 0.5rem; min-width: 300px; }
  .server-card {
    display: flex; justify-content: space-between; align-items: center;
    padding: 1rem; border: 1px solid var(--border, #1a2035);
    border-radius: 8px; background: var(--bg-secondary, #0f1525);
    cursor: pointer; color: inherit; font-family: inherit;
  }
  .server-card:hover { border-color: var(--accent, #4a9eff); }
  .server-ip { color: var(--text-secondary, #888); font-size: 0.85rem; }
  .no-servers { color: var(--text-secondary); }
  .divider { color: var(--text-secondary, #888); font-size: 0.85rem; }
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; width: 350px; }
  .form-group label { font-size: 0.9rem; color: var(--text-secondary); }
  .form-group input, .manual-form input {
    padding: 0.75rem; border: 1px solid var(--border, #1a2035);
    border-radius: 8px; background: var(--bg-secondary, #0f1525);
    color: inherit; font-size: 1rem;
  }
  .primary {
    padding: 0.75rem 2rem; background: var(--accent, #4a9eff);
    color: white; border: none; border-radius: 8px;
    cursor: pointer; font-size: 1rem; font-weight: 600;
  }
  .advanced { color: var(--text-secondary); font-size: 0.85rem; width: 350px; }
  .manual-form { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.5rem; }
  .error { color: #ff4444; }
  .success-text { color: #44ff88; font-size: 1.1rem; }
</style>
```

**Step 2: Verify build, commit**

```bash
pnpm --filter @eidolon/desktop build
git add apps/desktop/src/routes/onboarding/
git commit -m "feat(desktop): add client discovery and pairing screens"
```

---

## Phase 6: CLI Thin Wrapper

### Task 19: Refactor CLI onboard to use shared modules

**Files:**
- Modify: `packages/cli/src/commands/onboard.ts` -- import shared modules
- Modify: `packages/cli/src/commands/onboard-steps.ts` -- delegate to shared

**Step 1: Refactor onboard-steps.ts**

Replace inline implementations with calls to shared onboarding modules:

```typescript
// In setupMasterKey(), replace crypto.randomBytes with:
import { generateMasterKey } from "@eidolon/core";
const key = generateMasterKey();

// In gateway setup, replace inline token generation with:
import { generateAuthToken, detectTailscale, buildGatewayConfig } from "@eidolon/core";
const token = generateAuthToken();
const tailscaleIp = await detectTailscale();

// In database init, replace inline DB creation with:
import { initializeDatabases } from "@eidolon/core";
const dbResult = initializeDatabases(dataDir);

// In finalize, replace inline config building with:
import { buildServerConfig, writeConfig } from "@eidolon/core";
```

Keep the readline-based prompts in the CLI code -- only the _logic_ moves to shared modules.

**Step 2: Run existing CLI tests**

Run: `bun test packages/cli/`
Expected: all pass

**Step 3: Commit**

```bash
git add packages/cli/src/commands/
git commit -m "refactor(cli): delegate onboarding logic to shared core modules"
```

---

## Phase 7: Auto-connect & Desktop Polish

### Task 20: Add auto-connect on launch

**Files:**
- Modify: `apps/desktop/src/lib/stores/connection.ts`
- Modify: `apps/desktop/src/App.svelte`

**Step 1: Implement auto-connect**

In `App.svelte`, after determining `appState = "running"`:
- If role is "server": daemon is already started, connect to `ws://127.0.0.1:8419`
- If role is "client": read server config, connect to stored host/port

```typescript
// After appState = "running":
if (role === "server") {
  connectionStore.connect("127.0.0.1", 8419, false, "");
} else {
  const configJson = await invoke<string>("get_config_role"); // extend to return full server block
  // parse and connect
}
```

**Step 2: Persist settings in localStorage instead of sessionStorage**

In `apps/desktop/src/lib/stores/settings.ts`, change `sessionStorage` to `localStorage` for non-sensitive fields (host, port, tls). Keep token in sessionStorage.

**Step 3: Commit**

```bash
git add apps/desktop/src/
git commit -m "feat(desktop): auto-connect on launch and persist connection settings"
```

---

### Task 21: Add daemon logs command (D-5)

**Files:**
- Modify: `packages/cli/src/commands/daemon.ts` -- add logs subcommand

**Step 1: Add logs command**

```typescript
cmd
  .command("logs")
  .description("Tail daemon log file")
  .option("--lines <n>", "Number of lines to show", "50")
  .action(async (options: { readonly lines: string }) => {
    const logDir = getLogDir();
    const logFile = join(logDir, "eidolon.log");
    if (!existsSync(logFile)) {
      console.error(`No log file found at ${logFile}`);
      process.exitCode = 1;
      return;
    }
    const lines = parseInt(options.lines) || 50;
    const proc = Bun.spawn(["tail", "-n", String(lines), "-f", logFile], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  });
```

**Step 2: Commit**

```bash
git add packages/cli/src/commands/daemon.ts
git commit -m "feat(cli): add 'eidolon daemon logs' command"
```

---

## Phase 8: Integration Test & Final Commit

### Task 22: Export onboarding from core barrel

**Files:**
- Modify: `packages/core/src/index.ts` -- add onboarding exports

**Step 1: Add exports**

```typescript
// Onboarding
export {
  runPreflightChecks,
  getDefaultOwnerName,
  generateMasterKey,
  detectTailscale,
  generateAuthToken,
  buildGatewayConfig,
  initializeDatabases,
  buildServerConfig,
  buildClientConfig,
  writeConfig,
} from "./onboarding/index.ts";
```

**Step 2: Typecheck all**

Run: `pnpm -r typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export onboarding modules from barrel"
```

---

### Task 23: Run full test suite

**Step 1: Run all tests**

```bash
pnpm -r test
```

Expected: all 2781+ tests pass (plus new onboarding tests).

**Step 2: Run lint**

```bash
pnpm -r lint
```

**Step 3: Fix any issues, commit**

```bash
git add -A
git commit -m "fix: resolve lint and test issues from first-launch implementation"
```

---

### Task 24: Final integration verification

**Step 1: Build desktop**

```bash
pnpm -r build
```

**Step 2: Run desktop locally**

```bash
cd apps/desktop && pnpm tauri dev
```

Verify:
- App opens to role selection screen (no config)
- Selecting "Server" shows name + Claude screen
- Setup runs and reaches "Ready" screen
- Dashboard loads with connected status
- Closing and reopening auto-starts daemon and connects

**Step 3: Test CLI onboard**

```bash
bun packages/cli/src/index.ts onboard
```

Verify shared modules are used.

**Step 4: Final commit and push**

```bash
git push origin main
```
