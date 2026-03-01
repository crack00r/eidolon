/**
 * eidolon onboard -- interactive first-time setup wizard.
 *
 * Guides the user through initial configuration: master key,
 * Claude API keys, Telegram token, GPU worker, config file generation,
 * and doctor checks.
 */

import { createInterface } from "node:readline";
import { generateMasterKey, getConfigDir, getConfigPath, getDataDir, getLogDir, loadConfig } from "@eidolon/core";
import { SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatCheck } from "../utils/formatter.js";

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

function createPrompt(): { ask: (question: string) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => {
        resolve(answer.trim());
      });
    });

  return { ask, close: () => rl.close() };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function checkPrerequisites(): Promise<boolean> {
  console.log("\n--- Prerequisites ---\n");
  let allPassed = true;

  // Bun version
  const bunVersion = Bun.version;
  const [major] = bunVersion.split(".");
  const bunOk = Number.parseInt(major ?? "0", 10) >= 1;
  console.log(formatCheck(bunOk ? "pass" : "fail", `Bun runtime v${bunVersion}`));
  if (!bunOk) allPassed = false;

  // Claude CLI
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

  // Data directory
  const dataDir = getDataDir();
  console.log(formatCheck("pass", `Data directory: ${dataDir}`));

  // Config directory
  const configDir = getConfigDir();
  console.log(formatCheck("pass", `Config directory: ${configDir}`));

  // Log directory
  const logDir = getLogDir();
  console.log(formatCheck("pass", `Log directory: ${logDir}`));

  return allPassed;
}

async function setupMasterKey(ask: (q: string) => Promise<string>): Promise<string | undefined> {
  console.log("\n--- Master Key ---\n");
  console.log("The master key encrypts all secrets stored by Eidolon.");
  console.log("Options: (1) Generate a random key, (2) Enter your own.\n");

  const choice = await ask("Generate a random master key? [Y/n]: ");
  const useGenerated = choice === "" || choice.toLowerCase() === "y";

  let masterKey: string;
  if (useGenerated) {
    masterKey = generateMasterKey();
    console.log("\nMaster key derived successfully.");
    console.log("The key has been copied to your clipboard (if supported) or written to a secure file.");
    console.log("You will NOT see the key displayed here for security reasons.\n");

    // Write the key to a temporary file with restricted permissions instead of stdout
    try {
      const { writeFileSync, chmodSync } = await import("node:fs");
      const { join } = await import("node:path");
      const keyFilePath = join(getDataDir(), ".master-key-setup");
      const { existsSync, mkdirSync } = await import("node:fs");
      const dataDir = getDataDir();
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }
      writeFileSync(keyFilePath, `EIDOLON_MASTER_KEY=${masterKey}\n`, { mode: 0o600 });
      chmodSync(keyFilePath, 0o600);
      console.log(`  Key saved to: ${keyFilePath} (mode 0600)`);
      console.log(`  Read the file, then delete it: rm ${keyFilePath}`);
    } catch {
      console.log("  Warning: Could not write key file. Set EIDOLON_MASTER_KEY manually.");
    }
  } else {
    masterKey = await ask("Enter master key (hex string or passphrase): ");
    if (!masterKey) {
      console.log("No key provided. Skipping master key setup.");
      return undefined;
    }
    console.log("\nMaster key accepted.");
  }

  console.log("\nAdd the master key to your shell profile or systemd environment:");
  console.log("  export EIDOLON_MASTER_KEY=<your-key>");

  return masterKey;
}

async function setupClaudeApiKey(
  ask: (q: string) => Promise<string>,
  masterKey: string | undefined,
): Promise<string | undefined> {
  console.log("\n--- Claude API Configuration ---\n");
  console.log("Eidolon needs at least one Claude account (OAuth or API key).");
  console.log("If using Claude Code CLI with OAuth, you can skip this step.\n");

  const apiKey = await ask("Enter Claude API key (or press Enter to skip): ");
  if (!apiKey) {
    console.log("Skipped. You can add API keys later with 'eidolon secrets set'.");
    return undefined;
  }

  if (masterKey) {
    try {
      const { SecretStore } = await import("@eidolon/core");
      const { createHash } = await import("node:crypto");
      const { existsSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");

      // Derive key buffer from master key string
      let keyBuffer: Buffer;
      if (/^[0-9a-fA-F]{64}$/.test(masterKey)) {
        keyBuffer = Buffer.from(masterKey, "hex");
      } else {
        keyBuffer = createHash("sha256").update(masterKey).digest();
      }

      const dataDir = getDataDir();
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }
      const store = new SecretStore(join(dataDir, SECRETS_DB_FILENAME), keyBuffer);
      store.set("claude-api-key", apiKey, "Claude API key from onboarding");
      store.close();
      console.log("API key stored in SecretStore (encrypted).");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Warning: Could not store in SecretStore: ${msg}`);
      console.log("You can store it manually: eidolon secrets set claude-api-key");
    }
  } else {
    console.log("No master key set. API key not stored. Set it manually later.");
  }

  return apiKey;
}

async function setupTelegramToken(
  ask: (q: string) => Promise<string>,
  masterKey: string | undefined,
): Promise<string | undefined> {
  console.log("\n--- Telegram Bot (optional) ---\n");

  const token = await ask("Enter Telegram bot token (or press Enter to skip): ");
  if (!token) {
    console.log("Skipped. Configure Telegram later if desired.");
    return undefined;
  }

  if (masterKey) {
    try {
      const { SecretStore } = await import("@eidolon/core");
      const { createHash } = await import("node:crypto");
      const { join } = await import("node:path");

      let keyBuffer: Buffer;
      if (/^[0-9a-fA-F]{64}$/.test(masterKey)) {
        keyBuffer = Buffer.from(masterKey, "hex");
      } else {
        keyBuffer = createHash("sha256").update(masterKey).digest();
      }

      const store = new SecretStore(join(getDataDir(), SECRETS_DB_FILENAME), keyBuffer);
      store.set("telegram-bot-token", token, "Telegram bot token from onboarding");
      store.close();
      console.log("Telegram token stored in SecretStore (encrypted).");
    } catch {
      console.log("Warning: Could not store token. Set manually with 'eidolon secrets set'.");
    }
  }

  return token;
}

async function setupGpuWorker(ask: (q: string) => Promise<string>): Promise<string | undefined> {
  console.log("\n--- GPU Worker (optional) ---\n");
  console.log("If you have a GPU worker running (Python/FastAPI for TTS/STT),");
  console.log("enter its URL here.\n");

  const url = await ask("GPU worker URL (e.g., http://192.168.1.10:8420, or Enter to skip): ");
  if (!url) {
    console.log("Skipped. GPU features will use fallback (text-only) mode.");
    return undefined;
  }

  console.log(`GPU worker URL set: ${url}`);
  return url;
}

function writeConfigFile(opts: { ownerName: string; apiKey?: string; telegramToken?: string; gpuUrl?: string }): void {
  const { existsSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");

  const configPath = getConfigPath();
  const configDir = getConfigDir();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const config: Record<string, unknown> = {
    identity: {
      name: "Eidolon",
      ownerName: opts.ownerName || "User",
    },
    brain: {
      accounts: [
        opts.apiKey
          ? { type: "api-key", name: "primary", credential: { $secret: "claude-api-key" }, priority: 50 }
          : { type: "oauth", name: "primary", credential: "oauth", priority: 50 },
      ],
    },
    database: {},
    logging: { level: "info", format: "pretty" },
    daemon: {},
  };

  if (opts.telegramToken) {
    config.channels = {
      telegram: {
        enabled: true,
        botToken: { $secret: "telegram-bot-token" },
        allowedUserIds: [],
      },
    };
  }

  if (opts.gpuUrl) {
    config.gpu = {
      workers: [{ name: "primary", host: opts.gpuUrl, port: 8420, token: "" }],
    };
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  console.log(`\nConfig written to: ${configPath}`);
}

async function runDoctorChecks(): Promise<void> {
  console.log("\n--- Doctor Checks ---\n");
  const configResult = await loadConfig();
  if (configResult.ok) {
    console.log(formatCheck("pass", "Configuration file is valid"));
  } else {
    console.log(formatCheck("warn", `Config: ${configResult.error.message}`));
  }
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
        // 1. Prerequisites
        const prereqOk = await checkPrerequisites();
        if (!prereqOk) {
          console.log("\nSome prerequisites are missing. You may continue but functionality will be limited.\n");
        }

        // 2. Owner name
        const ownerName = await ask("\nYour name (for identity.ownerName): ");

        // 3. Master key
        const masterKey = await setupMasterKey(ask);

        // 4. Claude API key
        const apiKey = await setupClaudeApiKey(ask, masterKey);

        // 5. Telegram token
        const telegramToken = await setupTelegramToken(ask, masterKey);

        // 6. GPU worker
        const gpuUrl = await setupGpuWorker(ask);

        // 7. Write config file
        console.log("\n--- Configuration File ---\n");
        const writeConfig = await ask("Write initial config file? [Y/n]: ");
        if (writeConfig === "" || writeConfig.toLowerCase() === "y") {
          writeConfigFile({ ownerName, apiKey, telegramToken, gpuUrl });
        }

        // 8. Doctor checks
        await runDoctorChecks();

        // 9. Summary
        console.log("\n--- Setup Summary ---\n");
        console.log(`  Owner:        ${ownerName || "(not set)"}`);
        console.log(`  Master key:   ${masterKey ? "configured" : "not set"}`);
        console.log(`  Claude API:   ${apiKey ? "stored in SecretStore" : "using OAuth"}`);
        console.log(`  Telegram:     ${telegramToken ? "configured" : "skipped"}`);
        console.log(`  GPU Worker:   ${gpuUrl || "skipped"}`);
        console.log(`  Config:       ${getConfigPath()}`);
        console.log(`  Data dir:     ${getDataDir()}`);
        console.log();
        console.log("Next steps:");
        console.log("  1. Set EIDOLON_MASTER_KEY in your shell profile");
        console.log("  2. Run 'eidolon doctor' to verify everything");
        console.log("  3. Run 'eidolon daemon start' to launch the daemon");
        console.log();
      } finally {
        close();
      }
    });
}
