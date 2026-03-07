/**
 * eidolon onboard -- interactive first-time setup wizard.
 *
 * Supports two modes:
 * 1. Brain Server: full daemon setup with gateway, discovery, and services
 * 2. Client Only: discover and connect to an existing brain server
 *
 * Steps (server mode):
 *   1. System checks (Bun, Claude CLI, disk space)
 *   2. Identity (owner name with OS username default)
 *   3. Master key (generate or manual entry)
 *   4. Secret store initialization
 *   5. Claude account (OAuth or API key)
 *   6. Telegram (optional: bot token + allowed user IDs)
 *   7. GPU worker (optional: host, port, connection test)
 *   8. Database initialization (3 DBs with migrations)
 *   9. Health checks (run full diagnostics)
 *  10. Summary and next steps
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { getConfigDir, getConfigPath, getDataDir, zeroBuffer } from "@eidolon/core";
import { SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import type { Command } from "commander";
import { onboardClient } from "./onboard-client.ts";
import { deriveMasterKeyBuffer } from "./onboard-kdf.ts";
import { installPlatformService } from "./onboard-service.ts";
import type { AskFn, GpuSetupResult, TelegramSetupResult } from "./onboard-steps.ts";
import {
  checkPrerequisites,
  initializeDatabases,
  initializeSecretStore,
  runHealthChecks,
  setupClaudeAccount,
  setupGpuWorker,
  setupIdentity,
  setupMasterKey,
  setupTelegram,
} from "./onboard-steps.ts";

// ---------------------------------------------------------------------------
// ASCII banner
// ---------------------------------------------------------------------------

const BANNER = `
 ███████╗██╗██████╗  ██████╗ ██╗      ██████╗ ███╗   ██╗
 ██╔════╝██║██╔══██╗██╔═══██╗██║     ██╔═══██╗████╗  ██║
 █████╗  ██║██║  ██║██║   ██║██║     ██║   ██║██╔██╗ ██║
 ██╔══╝  ██║██║  ██║██║   ██║██║     ██║   ██║██║╚██╗██║
 ███████╗██║██████╔╝╚██████╔╝███████╗╚██████╔╝██║ ╚████║
 ╚══════╝╚═╝╚═════╝  ╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝
`;

// ---------------------------------------------------------------------------
// Readline helper
// ---------------------------------------------------------------------------

function createPrompt(): { ask: AskFn; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: AskFn = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  return { ask, close: () => rl.close() };
}

// ---------------------------------------------------------------------------
// Secret storage helper
// ---------------------------------------------------------------------------

function storeSecret(name: string, value: string, masterKey: string, description: string): boolean {
  let keyBuffer: Buffer | undefined;
  try {
    const { SecretStore } = require("@eidolon/core") as typeof import("@eidolon/core");
    const { join } = require("node:path") as typeof import("node:path");
    keyBuffer = deriveMasterKeyBuffer(masterKey);
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const store = new SecretStore(join(dataDir, SECRETS_DB_FILENAME), keyBuffer);
    store.set(name, value, description);
    store.close();
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Warning: Could not store secret: ${msg}`);
    return false;
  } finally {
    if (keyBuffer) zeroBuffer(keyBuffer);
  }
}

// ---------------------------------------------------------------------------
// Server onboard flow
// ---------------------------------------------------------------------------

interface ServerSetupResult {
  ownerName: string;
  masterKey?: string;
  claudeAccountType: "oauth" | "api-key";
  telegram: TelegramSetupResult;
  gpu: GpuSetupResult;
  gatewayPort: number;
  gatewayToken: string;
  gatewayHost: string;
  tlsEnabled: boolean;
  discoveryEnabled: boolean;
  tailscaleIp?: string;
  dbInitialized: boolean;
  healthOk: boolean;
}

async function onboardServer(ask: AskFn): Promise<ServerSetupResult> {
  // Step 2: Identity
  const ownerName = await setupIdentity(ask);

  // Step 3: Master key
  const masterKey = await setupMasterKey(ask);

  // Step 4: Secret store init
  if (masterKey) {
    initializeSecretStore(masterKey);
  }

  // Step 5: Claude account
  const claude = await setupClaudeAccount(ask);
  if (claude.apiKey && masterKey) {
    const ok = storeSecret("claude-api-key", claude.apiKey, masterKey, "Claude API key from onboarding");
    console.log(ok ? "  API key encrypted and stored." : "  API key not stored.");
  }

  // Gateway setup
  console.log("\n--- Gateway Setup ---\n");
  const portInput = await ask("Gateway port [8419]: ");
  const gatewayPort = Number.parseInt(portInput, 10) || 8419;

  const tokenChoice = await ask("Auth token (auto-generate or enter manually) [auto]: ");
  const { generateAuthToken } = await import("@eidolon/core");
  const gatewayToken = tokenChoice || generateAuthToken();
  if (!tokenChoice) {
    const masked = gatewayToken.length > 8 ? `${gatewayToken.slice(0, 4)}..${gatewayToken.slice(-4)}` : "****";
    console.log(`  Generated token: ${masked}`);
  }
  if (masterKey) {
    storeSecret("gateway-auth-token", gatewayToken, masterKey, "Gateway auth token from onboarding");
  }

  const tlsChoice = await ask("Enable TLS? [y/N]: ");
  const tlsEnabled = tlsChoice.toLowerCase() === "y";

  const bindChoice = await ask("Bind to all interfaces (0.0.0.0)? [Y/n]: ");
  const gatewayHost = bindChoice.toLowerCase() === "n" ? "127.0.0.1" : "0.0.0.0";

  // Discovery
  console.log("\n--- Network Discovery ---\n");
  const discChoice = await ask("Enable network broadcast? [Y/n]: ");
  const discoveryEnabled = discChoice === "" || discChoice.toLowerCase() === "y";

  let tailscaleIp: string | undefined;
  try {
    const result = Bun.spawnSync(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      tailscaleIp = result.stdout.toString().trim();
      if (tailscaleIp) console.log(`  Tailscale detected: ${tailscaleIp}`);
    }
  } catch {
    /* Tailscale not installed */
  }

  // Step 6: Telegram
  const telegram = await setupTelegram(ask);
  if (telegram.botToken && masterKey) {
    storeSecret("telegram-bot-token", telegram.botToken, masterKey, "Telegram bot token from onboarding");
  }

  // Step 7: GPU worker
  const gpu = await setupGpuWorker(ask);
  if (gpu.host && masterKey) {
    const gpuToken = await ask("GPU worker auth token (Enter to skip): ");
    if (gpuToken) {
      storeSecret("gpu-worker-token", gpuToken, masterKey, "GPU worker auth token from onboarding");
    }
  }

  // Step 8: Database initialization
  const dbInitialized = initializeDatabases();

  // Step 9: Health checks
  const healthOk = await runHealthChecks(!!masterKey);

  return {
    ownerName,
    masterKey,
    claudeAccountType: claude.type,
    telegram,
    gpu,
    gatewayPort,
    gatewayToken,
    gatewayHost,
    tlsEnabled,
    discoveryEnabled,
    tailscaleIp,
    dbInitialized,
    healthOk,
  };
}

// ---------------------------------------------------------------------------
// Config file writer (server mode)
// ---------------------------------------------------------------------------

function writeServerConfig(r: ServerSetupResult): void {
  const configPath = getConfigPath();
  const configDir = getConfigDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const config: Record<string, unknown> = {
    identity: { name: "Eidolon", ownerName: r.ownerName || "User" },
    brain: {
      accounts: [
        r.claudeAccountType === "api-key"
          ? { type: "api-key", name: "primary", credential: { $secret: "claude-api-key" }, priority: 50 }
          : { type: "oauth", name: "primary", credential: "oauth", priority: 50 },
      ],
    },
    gateway: {
      host: r.gatewayHost,
      port: r.gatewayPort,
      tls: { enabled: r.tlsEnabled },
      auth: { type: "token", token: { $secret: "gateway-auth-token" } },
    },
    database: {},
    logging: { level: "info", format: "pretty" },
    daemon: {},
  };

  if (r.telegram.enabled) {
    config.channels = {
      telegram: {
        enabled: true,
        botToken: { $secret: "telegram-bot-token" },
        allowedUserIds: r.telegram.allowedUserIds,
      },
    };
  }
  if (r.gpu.enabled && r.gpu.host) {
    config.gpu = {
      workers: [
        {
          name: "primary",
          host: r.gpu.host,
          port: r.gpu.port,
          token: { $secret: "gpu-worker-token" },
          capabilities: ["tts", "stt"],
        },
      ],
    };
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  if (process.platform !== "win32") {
    chmodSync(configPath, 0o600);
  }
  console.log(`\n  Config written to: ${configPath} (mode 0600)`);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Interactive first-time setup wizard")
    .action(async () => {
      console.log(BANNER);
      console.log(`  Eidolon v${VERSION} -- First-Time Setup Wizard`);
      console.log("  Autonomous, self-learning personal AI assistant\n");

      const { ask, close } = createPrompt();

      try {
        // Step 1: Prerequisites
        const prereqs = await checkPrerequisites();
        if (!prereqs.allPassed) {
          console.log("\nSome prerequisites are missing. Functionality may be limited.\n");
        }

        // Role selection
        console.log("\n--- What role should this machine have? ---\n");
        console.log("  [1] Brain Server (runs the AI daemon)");
        console.log("  [2] Client Only (connects to an existing server)\n");

        const roleChoice = await ask("Select role [1]: ");
        const isClient = roleChoice === "2";

        if (isClient) {
          await onboardClient(ask);
        } else {
          const result = await onboardServer(ask);

          // Write config
          console.log("\n--- Step 10: Finalize ---\n");
          const writeChoice = await ask("Write config file? [Y/n]: ");
          if (writeChoice === "" || writeChoice.toLowerCase() === "y") {
            writeServerConfig(result);
          }

          // Platform service
          const serviceChoice = await ask("\nInstall as system service? [Y/n]: ");
          if (serviceChoice === "" || serviceChoice.toLowerCase() === "y") {
            await installPlatformService(result.masterKey);
          }

          // Summary
          const scheme = result.tlsEnabled ? "wss" : "ws";
          const host = result.gatewayHost === "0.0.0.0" ? "localhost" : result.gatewayHost;

          console.log("\n--- Setup Summary ---\n");
          console.log(`  Owner:        ${result.ownerName}`);
          console.log(`  Master key:   ${result.masterKey ? "configured" : "not set"}`);
          console.log(`  Claude:       ${result.claudeAccountType}`);
          console.log(`  Gateway:      ${scheme}://${host}:${result.gatewayPort}`);
          console.log(`  Discovery:    ${result.discoveryEnabled ? "enabled" : "disabled"}`);
          if (result.tailscaleIp) console.log(`  Tailscale:    ${result.tailscaleIp}`);
          console.log(`  Telegram:     ${result.telegram.enabled ? "configured" : "skipped"}`);
          if (result.telegram.enabled) {
            console.log(
              `  Telegram IDs: ${result.telegram.allowedUserIds.length > 0 ? result.telegram.allowedUserIds.join(", ") : "(none)"}`,
            );
          }
          console.log(
            `  GPU Worker:   ${result.gpu.enabled ? `${result.gpu.host}:${result.gpu.port} (${result.gpu.reachable ? "reachable" : "not reachable"})` : "skipped"}`,
          );
          console.log(`  Databases:    ${result.dbInitialized ? "initialized" : "FAILED"}`);
          console.log(`  Health:       ${result.healthOk ? "all checks passed" : "some checks failed"}`);
          console.log(`  Config:       ${getConfigPath()}`);
          console.log(`  Data dir:     ${getDataDir()}`);
          console.log();
          console.log("Next steps:");
          console.log("  1. Set EIDOLON_MASTER_KEY in your shell profile");
          console.log("  2. Run 'eidolon doctor' to verify everything");
          console.log("  3. Run 'eidolon daemon start' to start the server");
          console.log("  4. Run 'eidolon pair' to connect clients");
          console.log();
        }
      } finally {
        close();
      }
    });
}
