/**
 * eidolon onboard -- interactive first-time setup wizard.
 *
 * Supports two modes:
 * 1. Brain Server: full daemon setup with gateway, discovery, and services
 * 2. Client Only: discover and connect to an existing brain server
 */

import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";
import {
  generateMasterKey,
  getConfigDir,
  getConfigPath,
  getDataDir,
  getLogDir,
  KEY_LENGTH,
  loadConfig,
  PASSPHRASE_SALT,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  zeroBuffer,
} from "@eidolon/core";
import { SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatCheck } from "../utils/formatter.ts";
import { installPlatformService } from "./onboard-service.ts";

/** scrypt KDF parameters -- imported from core for consistency. */
const SCRYPT_PARAMS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };

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

type AskFn = (question: string) => Promise<string>;

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
// KDF helper
// ---------------------------------------------------------------------------

function deriveMasterKeyBuffer(masterKey: string): Buffer {
  const hexKeyLength = KEY_LENGTH * 2;
  if (new RegExp(`^[0-9a-fA-F]{${hexKeyLength}}$`).test(masterKey)) {
    return Buffer.from(masterKey, "hex");
  }
  return scryptSync(masterKey, PASSPHRASE_SALT, KEY_LENGTH, SCRYPT_PARAMS);
}

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

async function checkPrerequisites(): Promise<boolean> {
  console.log("\n--- Prerequisites ---\n");
  let allPassed = true;

  const bunVersion = Bun.version;
  const [major] = bunVersion.split(".");
  const bunOk = Number.parseInt(major ?? "0", 10) >= 1;
  console.log(formatCheck(bunOk ? "pass" : "fail", `Bun runtime v${bunVersion}`));
  if (!bunOk) allPassed = false;

  try {
    const result = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const output = result.stdout.toString().trim();
    const cliOk = result.exitCode === 0 && output.length > 0;
    console.log(formatCheck(cliOk ? "pass" : "fail", `Claude Code CLI ${output || "(not found)"}`));
    if (!cliOk) allPassed = false;
  } catch {
    console.log(formatCheck("fail", "Claude Code CLI not installed"));
    allPassed = false;
  }

  console.log(formatCheck("pass", `Data directory: ${getDataDir()}`));
  console.log(formatCheck("pass", `Config directory: ${getConfigDir()}`));
  console.log(formatCheck("pass", `Log directory: ${getLogDir()}`));

  return allPassed;
}

// ---------------------------------------------------------------------------
// Master key setup
// ---------------------------------------------------------------------------

async function setupMasterKey(ask: AskFn): Promise<string | undefined> {
  console.log("\n--- Step: Security ---\n");
  console.log("The master key encrypts all secrets stored by Eidolon.\n");

  const choice = await ask("Generate master encryption key? [Y/n]: ");
  const useGenerated = choice === "" || choice.toLowerCase() === "y";

  let masterKey: string;
  if (useGenerated) {
    masterKey = generateMasterKey();
    console.log("\nMaster key generated.");
    try {
      const { writeFileSync, chmodSync, existsSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dataDir = getDataDir();
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      const keyFilePath = join(dataDir, ".master-key-setup");
      writeFileSync(keyFilePath, `EIDOLON_MASTER_KEY=${masterKey}\n`, { mode: 0o600 });
      chmodSync(keyFilePath, 0o600);
      console.log(`  Key saved to: ${keyFilePath} (mode 0600)`);
      console.log(`  Read the file, then delete it: rm ${keyFilePath}`);
      setTimeout(() => {
        try {
          const fs = require("node:fs") as typeof import("node:fs");
          fs.writeFileSync(keyFilePath, randomBytes(64));
          fs.unlinkSync(keyFilePath);
        } catch {
          /* best effort */
        }
      }, 60_000).unref();
    } catch {
      console.log("  Warning: Could not write key file. Set EIDOLON_MASTER_KEY manually.");
    }
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
// Secret storage helper
// ---------------------------------------------------------------------------

async function storeSecret(name: string, value: string, masterKey: string, description: string): Promise<boolean> {
  let keyBuffer: Buffer | undefined;
  try {
    const { SecretStore } = await import("@eidolon/core");
    const { existsSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
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
  apiKey?: string;
  telegramToken?: string;
  gpuUrl?: string;
  gatewayPort: number;
  gatewayToken: string;
  gatewayHost: string;
  tlsEnabled: boolean;
  discoveryEnabled: boolean;
  tailscaleIp?: string;
}

async function onboardServer(ask: AskFn): Promise<ServerSetupResult> {
  // Identity
  console.log("\n--- Step 2: Identity ---\n");
  const ownerName = await ask("Owner name: ");

  // Security
  const masterKey = await setupMasterKey(ask);

  // Claude account
  console.log("\n--- Step 4: Claude Account ---\n");
  const apiKey = await ask("Claude API key (optional, Enter to skip): ");
  if (apiKey && masterKey) {
    const ok = await storeSecret("claude-api-key", apiKey, masterKey, "Claude API key from onboarding");
    console.log(ok ? "  API key encrypted and stored." : "  API key not stored.");
  }

  // Gateway setup
  console.log("\n--- Step 5: Gateway Setup ---\n");
  const portInput = await ask("Gateway port [8419]: ");
  const gatewayPort = Number.parseInt(portInput, 10) || 8419;

  const tokenChoice = await ask("Auth token (auto-generate or enter manually) [auto]: ");
  // Dynamic import to avoid mock.module issues in tests
  const { generateAuthToken } = await import("@eidolon/core");
  const gatewayToken = tokenChoice || generateAuthToken();
  if (!tokenChoice) {
    console.log(`  Generated token: ${gatewayToken}`);
  }
  if (masterKey) {
    await storeSecret("gateway-auth-token", gatewayToken, masterKey, "Gateway auth token from onboarding");
  }

  const tlsChoice = await ask("Enable TLS? [y/N]: ");
  const tlsEnabled = tlsChoice.toLowerCase() === "y";

  const bindChoice = await ask("Bind to all interfaces (0.0.0.0)? [Y/n]: ");
  const gatewayHost = bindChoice.toLowerCase() === "n" ? "127.0.0.1" : "0.0.0.0";

  // Discovery
  console.log("\n--- Step 6: Network Discovery ---\n");
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

  if (discoveryEnabled) {
    console.log("  Clients on your network will auto-discover this server.");
  }

  // Channels
  console.log("\n--- Step 7: Channels (optional) ---\n");
  const telegramToken = await ask("Telegram bot token (Enter to skip): ");
  if (telegramToken && masterKey) {
    await storeSecret("telegram-bot-token", telegramToken, masterKey, "Telegram bot token from onboarding");
  }
  const gpuUrl = await ask("GPU worker URL (Enter to skip): ");

  return {
    ownerName,
    masterKey,
    apiKey: apiKey || undefined,
    telegramToken: telegramToken || undefined,
    gpuUrl: gpuUrl || undefined,
    gatewayPort,
    gatewayToken,
    gatewayHost,
    tlsEnabled,
    discoveryEnabled,
    tailscaleIp,
  };
}

// ---------------------------------------------------------------------------
// Config file writer (server mode)
// ---------------------------------------------------------------------------

function writeServerConfig(r: ServerSetupResult): void {
  const { existsSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const configPath = getConfigPath();
  const configDir = getConfigDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const config: Record<string, unknown> = {
    identity: { name: "Eidolon", ownerName: r.ownerName || "User" },
    brain: {
      accounts: [
        r.apiKey
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

  if (r.telegramToken) {
    config.channels = {
      telegram: { enabled: true, botToken: { $secret: "telegram-bot-token" }, allowedUserIds: [] },
    };
  }
  if (r.gpuUrl) {
    config.gpu = { workers: [{ name: "primary", host: r.gpuUrl, port: 8420, token: "" }] };
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  console.log(`\n  Config written to: ${configPath}`);
}

// ---------------------------------------------------------------------------
// Client config writer + connection test
// ---------------------------------------------------------------------------

function writeClientConfig(host: string, port: number, token: string, tls: boolean): void {
  const { existsSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const configPath = getConfigPath();
  const configDir = getConfigDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

  const config = {
    role: "client",
    server: {
      host,
      port,
      token,
      tls,
    },
    logging: { level: "info", format: "pretty" },
  };

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  console.log(`\n  Client config written to: ${configPath}`);
}

async function testConnection(host: string, _port: number, tls: boolean): Promise<void> {
  console.log("\n--- Testing connection... ---\n");
  const protocol = tls ? "https" : "http";
  try {
    const response = await fetch(`${protocol}://${host}:9419/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      console.log(`  Server is reachable! Status: ${String(data.status ?? "unknown")}`);
    } else {
      console.log(`  Server responded with HTTP ${response.status}. It may still work.`);
    }
  } catch {
    console.log("  Could not reach health endpoint. Server may not be running yet.");
    console.log("  The client apps will retry automatically when started.");
  }
}

// ---------------------------------------------------------------------------
// Client onboard flow
// ---------------------------------------------------------------------------

async function onboardClient(ask: AskFn): Promise<void> {
  console.log("\n--- Step 2: Searching for Eidolon servers... ---\n");
  console.log("  Listening for broadcast beacons (5 seconds)...");

  const servers = await discoverServers();

  let host: string | undefined;
  let port = 8419;
  let token = "";
  let tls = false;

  if (servers.length > 0) {
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      if (!s) continue;
      const via = s.tailscaleIp ? " (tailscale)" : " (local)";
      console.log(`  [${i + 1}] "${s.hostname}" at ${s.host}:${s.port}${via}`);
    }
    const selInput = await ask(`\nSelect server [1]: `);
    const selIdx = (Number.parseInt(selInput, 10) || 1) - 1;
    const selected = servers[selIdx];
    if (selected) {
      host = selected.tailscaleIp ?? selected.host;
      port = selected.port;
      console.log(`\n  Selected: ${host}:${port}`);
      token = await ask("Auth token: ");
    }
  }

  if (!host) {
    if (servers.length === 0) {
      console.log("  No servers found via broadcast.");
    }
    const manual = await ask("\nEnter server address manually (host:port): ");
    if (manual) {
      const parts = manual.split(":");
      host = parts[0] ?? manual;
      if (parts.length > 1) {
        port = Number.parseInt(parts[1] ?? "8419", 10) || 8419;
      }
      token = await ask("Auth token: ");
    }
  }

  if (!host) {
    console.log("  No server configured. Run 'eidolon onboard' again when ready.");
    return;
  }

  const tlsChoice = await ask("Server uses TLS? [y/N]: ");
  tls = tlsChoice.toLowerCase() === "y";

  // Write client config
  writeClientConfig(host, port, token, tls);

  // Try a quick connection test via HTTP health endpoint
  await testConnection(host, port, tls);

  console.log("\n--- Setup Complete ---\n");
  console.log(`  Server:  ${tls ? "wss" : "ws"}://${host}:${port}`);
  console.log(`  Token:   ${token ? "configured" : "not set"}`);
  console.log(`  Config:  ${getConfigPath()}`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Open the Desktop, iOS, or Web app");
  console.log("  2. The app will auto-connect using the saved config");
  console.log("  3. Or run 'eidolon chat' for CLI interaction");
  console.log();
}

interface DiscoveredServer {
  hostname: string;
  host: string;
  port: number;
  tailscaleIp?: string;
}

async function discoverServers(): Promise<DiscoveredServer[]> {
  const servers: DiscoveredServer[] = [];
  try {
    const { DISCOVERY_PORT } = await import("@eidolon/core");
    const socket = await Bun.udpSocket({
      port: DISCOVERY_PORT,
      socket: {
        data(_socket, buf, _port, _addr) {
          try {
            const text = Buffer.from(buf).toString("utf-8");
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === "object" && parsed !== null) {
              const obj = parsed as Record<string, unknown>;
              if (obj.service === "eidolon") {
                servers.push({
                  hostname: String(obj.hostname ?? "unknown"),
                  host: String(obj.host ?? ""),
                  port: Number(obj.port ?? 8419),
                  ...(typeof obj.tailscaleIp === "string" ? { tailscaleIp: obj.tailscaleIp } : {}),
                });
              }
            }
          } catch {
            /* ignore malformed packets */
          }
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    socket.close();
  } catch {
    // UDP socket not available, skip discovery
  }
  return servers;
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
        const prereqOk = await checkPrerequisites();
        if (!prereqOk) {
          console.log("\nSome prerequisites are missing. Functionality may be limited.\n");
        }

        // Step 1: Role selection
        console.log("\n--- Step 1: What role should this machine have? ---\n");
        console.log("  [1] Brain Server (runs the AI daemon)");
        console.log("  [2] Client Only (connects to an existing server)\n");

        const roleChoice = await ask("Select role [1]: ");
        const isClient = roleChoice === "2";

        if (isClient) {
          await onboardClient(ask);
        } else {
          const result = await onboardServer(ask);

          // Write config
          console.log("\n--- Configuration ---\n");
          const writeChoice = await ask("Write config file? [Y/n]: ");
          if (writeChoice === "" || writeChoice.toLowerCase() === "y") {
            writeServerConfig(result);
          }

          // Platform service
          console.log("\n--- Step 8: Platform Service ---\n");
          const serviceChoice = await ask("Install as system service? [Y/n]: ");
          if (serviceChoice === "" || serviceChoice.toLowerCase() === "y") {
            await installPlatformService(result.masterKey);
          }

          // Doctor checks
          console.log("\n--- Doctor Checks ---\n");
          const configResult = await loadConfig();
          console.log(
            formatCheck(
              configResult.ok ? "pass" : "warn",
              configResult.ok ? "Configuration file is valid" : `Config: ${configResult.error.message}`,
            ),
          );

          // Summary with pairing URL
          const scheme = result.tlsEnabled ? "wss" : "ws";
          const host = result.gatewayHost === "0.0.0.0" ? "localhost" : result.gatewayHost;
          const pairingUrl = `eidolon://${host}:${result.gatewayPort}?token=${result.gatewayToken}&tls=${result.tlsEnabled}`;

          console.log("\n--- Setup Summary ---\n");
          console.log(`  Owner:        ${result.ownerName || "(not set)"}`);
          console.log(`  Master key:   ${result.masterKey ? "configured" : "not set"}`);
          console.log(`  Claude API:   ${result.apiKey ? "stored" : "using OAuth"}`);
          console.log(`  Gateway:      ${scheme}://${host}:${result.gatewayPort}`);
          console.log(`  Discovery:    ${result.discoveryEnabled ? "enabled" : "disabled"}`);
          if (result.tailscaleIp) {
            console.log(`  Tailscale:    ${result.tailscaleIp}`);
          }
          console.log(`  Telegram:     ${result.telegramToken ? "configured" : "skipped"}`);
          console.log(`  GPU Worker:   ${result.gpuUrl || "skipped"}`);
          console.log(`  Config:       ${getConfigPath()}`);
          console.log(`  Data dir:     ${getDataDir()}`);
          console.log();
          console.log(`  Pairing URL:  ${pairingUrl}`);
          console.log();
          console.log("Next steps:");
          console.log("  1. Set EIDOLON_MASTER_KEY in your shell profile");
          console.log("  2. Run 'eidolon doctor' to verify everything");
          console.log("  3. Run 'eidolon daemon start' to start the server");
          console.log("  4. Run 'eidolon pair' to get connection details");
          console.log();
        }
      } finally {
        close();
      }
    });
}
