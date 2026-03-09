/**
 * Individual step functions for the onboard wizard.
 *
 * Extracted from onboard.ts to keep each file under ~300 lines.
 * Each exported function performs one discrete step of the setup wizard.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateMasterKey,
  getConfigDir,
  getDataDir,
  getDefaultOwnerName,
  getLogDir,
  initializeDatabases as initializeDatabasesShared,
  loadConfig,
  runPreflightChecks,
  SecretStore,
  zeroBuffer,
} from "@eidolon/core";
import { SECRETS_DB_FILENAME } from "@eidolon/protocol";
import { formatCheck } from "../utils/formatter.ts";
import { deriveMasterKeyBuffer } from "./onboard-kdf.ts";

export type AskFn = (question: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

export interface PrerequisiteResult {
  readonly bunOk: boolean;
  readonly claudeOk: boolean;
  readonly diskOk: boolean;
  readonly allPassed: boolean;
}

export async function checkPrerequisites(): Promise<PrerequisiteResult> {
  console.log("\n--- Step 1: System Checks ---\n");

  // Delegate system checks to shared module
  const preflight = runPreflightChecks();
  const bunOk = preflight.ok ? Number.parseInt(preflight.value.bunVersion.split(".")[0] ?? "0", 10) >= 1 : false;
  const diskOk = preflight.ok ? preflight.value.diskSpaceMb >= 500 || preflight.value.diskSpaceMb === 0 : false;

  if (preflight.ok) {
    console.log(formatCheck(bunOk ? "pass" : "fail", `Bun runtime v${preflight.value.bunVersion}`));
    if (preflight.value.diskSpaceMb > 0) {
      console.log(formatCheck(diskOk ? "pass" : "warn", `Disk space: ${preflight.value.diskSpaceMb} MB free`));
    } else {
      console.log(formatCheck("warn", "Disk space: could not determine"));
    }
  } else {
    console.log(formatCheck("fail", `System check failed: ${preflight.error.message}`));
  }

  // Claude Code CLI (not covered by shared preflight)
  let claudeOk = false;
  try {
    const result = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString().trim();
    claudeOk = result.exitCode === 0 && output.length > 0;
    console.log(formatCheck(claudeOk ? "pass" : "fail", `Claude Code CLI ${output || "(not found)"}`));
  } catch {
    console.log(formatCheck("fail", "Claude Code CLI not installed"));
  }

  // Directory paths (info only)
  console.log(formatCheck("pass", `Data directory: ${getDataDir()}`));
  console.log(formatCheck("pass", `Config directory: ${getConfigDir()}`));
  console.log(formatCheck("pass", `Log directory: ${getLogDir()}`));

  return {
    bunOk,
    claudeOk,
    diskOk,
    allPassed: bunOk && claudeOk && diskOk,
  };
}

// ---------------------------------------------------------------------------
// Identity setup
// ---------------------------------------------------------------------------

export async function setupIdentity(ask: AskFn): Promise<string> {
  console.log("\n--- Step 2: Identity ---\n");
  const defaultName = getDefaultOwnerName();
  const ownerName = await ask(`Owner name [${defaultName}]: `);
  return ownerName || defaultName;
}

// ---------------------------------------------------------------------------
// Master key setup
// ---------------------------------------------------------------------------

export async function setupMasterKey(ask: AskFn): Promise<string | undefined> {
  console.log("\n--- Step 3: Security ---\n");
  console.log("The master key encrypts all secrets stored by Eidolon.\n");

  const choice = await ask("Generate master encryption key? [Y/n]: ");
  const useGenerated = choice === "" || choice.toLowerCase() === "y";

  let masterKey: string;
  if (useGenerated) {
    masterKey = generateMasterKey();
    console.log("\nMaster key generated. Copy it now -- it will NOT be shown again.\n");
    console.log(`  EIDOLON_MASTER_KEY=${masterKey}\n`);
    console.warn("  ⚠ Clear your terminal history after copying this key (Cmd+K / clear)");
    console.log("  Add the line above to your shell profile (e.g. ~/.bashrc or ~/.zshrc).");
  } else {
    masterKey = await ask("Enter master key (hex string or passphrase): ");
    if (!masterKey) {
      console.log("No key provided. Skipping.");
      return undefined;
    }
  }

  console.log("\n  export EIDOLON_MASTER_KEY=<your-key>");
  return masterKey;
}

// ---------------------------------------------------------------------------
// Secret store initialization
// ---------------------------------------------------------------------------

export function initializeSecretStore(masterKeyHex: string): boolean {
  console.log("\n--- Step 4: Secret Store ---\n");
  let keyBuffer: Buffer | undefined;
  try {
    keyBuffer = deriveMasterKeyBuffer(masterKeyHex);
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, SECRETS_DB_FILENAME);
    const store = new SecretStore(dbPath, keyBuffer);
    store.close();
    console.log(formatCheck("pass", `Secret store initialized at ${dbPath}`));
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(formatCheck("fail", `Secret store initialization failed: ${msg}`));
    return false;
  } finally {
    if (keyBuffer) zeroBuffer(keyBuffer);
  }
}

// ---------------------------------------------------------------------------
// Claude account setup
// ---------------------------------------------------------------------------

export async function setupClaudeAccount(ask: AskFn): Promise<{ type: "oauth" | "api-key"; apiKey?: string }> {
  console.log("\n--- Step 5: Claude Account ---\n");
  console.log("  [1] OAuth (recommended -- uses Anthropic Max subscription)");
  console.log("  [2] API Key\n");

  const accountChoice = await ask("Select authentication method [1]: ");
  const useApiKey = accountChoice === "2";

  if (useApiKey) {
    const apiKey = await ask("Enter Anthropic API key: ");
    if (!apiKey) {
      console.log("  No API key provided. Falling back to OAuth.");
      return { type: "oauth" };
    }
    if (!apiKey.startsWith("sk-ant-") && !apiKey.startsWith("sk-")) {
      console.log('  Warning: API key does not start with "sk-ant-" or "sk-". It may be invalid.');
    }
    return { type: "api-key", apiKey };
  }

  console.log("  Using OAuth. Run 'claude login' if not already authenticated.");
  return { type: "oauth" };
}

// ---------------------------------------------------------------------------
// Telegram setup
// ---------------------------------------------------------------------------

export interface TelegramSetupResult {
  readonly enabled: boolean;
  readonly botToken?: string;
  readonly allowedUserIds: number[];
}

export async function setupTelegram(ask: AskFn): Promise<TelegramSetupResult> {
  console.log("\n--- Step 6: Telegram (optional) ---\n");
  const botToken = await ask("Telegram bot token (Enter to skip): ");
  if (!botToken) {
    return { enabled: false, allowedUserIds: [] };
  }

  const userIdsInput = await ask("Allowed Telegram user IDs (comma-separated): ");
  const allowedUserIds = userIdsInput
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => !Number.isNaN(n));

  if (allowedUserIds.length === 0) {
    console.log("  Warning: No user IDs configured. The bot will reject all messages.");
    console.log("  You can add user IDs later in eidolon.json.");
  }

  return { enabled: true, botToken, allowedUserIds };
}

// ---------------------------------------------------------------------------
// GPU worker setup
// ---------------------------------------------------------------------------

export interface GpuSetupResult {
  readonly enabled: boolean;
  readonly host?: string;
  readonly port: number;
  readonly reachable: boolean;
}

export async function setupGpuWorker(ask: AskFn): Promise<GpuSetupResult> {
  console.log("\n--- Step 7: GPU Worker (optional) ---\n");
  const hostInput = await ask("GPU worker host (Enter to skip): ");
  if (!hostInput) {
    return { enabled: false, port: 8420, reachable: false };
  }

  const portInput = await ask("GPU worker port [8420]: ");
  let port = Number.parseInt(portInput, 10) || 8420;
  if (port < 1 || port > 65535) {
    console.log(`  Invalid port ${port}. Using default 8420.`);
    port = 8420;
  }

  // Test connection
  let reachable = false;
  console.log(`\n  Testing connection to ${hostInput}:${port}...`);
  try {
    const response = await fetch(`http://${hostInput}:${port}/health`, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (response.ok) {
      console.log(formatCheck("pass", "GPU worker is reachable"));
      reachable = true;
    } else {
      console.log(formatCheck("warn", `GPU worker responded with HTTP ${response.status}`));
    }
  } catch {
    console.log(formatCheck("warn", "GPU worker not reachable (may not be running yet)"));
  }

  return { enabled: true, host: hostInput, port, reachable };
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

export function initializeDatabases(): boolean {
  console.log("\n--- Step 8: Database Initialization ---\n");
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const result = initializeDatabasesShared(dataDir);
  if (!result.ok) {
    console.log(formatCheck("fail", `Database initialization failed: ${result.error.message}`));
    return false;
  }

  console.log(formatCheck("pass", `memory.db   (${result.value.memoryTables} tables)`));
  console.log(formatCheck("pass", `operational.db (${result.value.operationalTables} tables)`));
  console.log(formatCheck("pass", `audit.db    (${result.value.auditTables} tables)`));
  return true;
}

// ---------------------------------------------------------------------------
// Health checks (final verification)
// ---------------------------------------------------------------------------

export async function runHealthChecks(masterKeySet: boolean): Promise<boolean> {
  console.log("\n--- Step 9: Health Checks ---\n");
  let allOk = true;

  // Bun
  const [major] = Bun.version.split(".");
  const bunOk = Number.parseInt(major ?? "0", 10) >= 1;
  console.log(formatCheck(bunOk ? "pass" : "fail", `Bun runtime v${Bun.version}`));
  if (!bunOk) allOk = false;

  // Claude CLI
  try {
    const result = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const cliOk = result.exitCode === 0;
    console.log(
      formatCheck(cliOk ? "pass" : "fail", `Claude Code CLI ${result.stdout.toString().trim() || "(missing)"}`),
    );
    if (!cliOk) allOk = false;
  } catch {
    console.log(formatCheck("fail", "Claude Code CLI not installed"));
    allOk = false;
  }

  // Config
  const configResult = await loadConfig();
  console.log(
    formatCheck(
      configResult.ok ? "pass" : "warn",
      configResult.ok ? "Configuration file valid" : `Config: ${configResult.error.message}`,
    ),
  );

  // Master key
  console.log(formatCheck(masterKeySet ? "pass" : "warn", `Master key ${masterKeySet ? "configured" : "not set"}`));

  // Data dir writable
  const dataDir = getDataDir();
  try {
    const testFile = join(dataDir, `.onboard-test-${Date.now()}`);
    writeFileSync(testFile, "test");
    unlinkSync(testFile);
    console.log(formatCheck("pass", `Data directory writable (${dataDir})`));
  } catch {
    console.log(formatCheck("fail", `Data directory not writable (${dataDir})`));
    allOk = false;
  }

  // Databases
  try {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const testPath = join(dataDir, `.onboard-db-test-${Date.now()}.db`);
    const db = new Database(testPath, { create: true });
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY)");
    db.close();
    unlinkSync(testPath);
    console.log(formatCheck("pass", "Database connections OK"));
  } catch {
    console.log(formatCheck("fail", "Database connections failed"));
    allOk = false;
  }

  return allOk;
}
