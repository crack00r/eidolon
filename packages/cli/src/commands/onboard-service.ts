/**
 * Platform service installation helper for onboard wizard.
 *
 * Installs Eidolon as a system service:
 * - macOS: LaunchAgent plist
 * - Linux: systemd user service
 * - Windows: startup script or scheduled task
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Bun path detection
// ---------------------------------------------------------------------------

/** Detect the actual path to the bun binary. */
function detectBunPath(): string {
  // 1. Try `which bun` (works when running under Bun)
  try {
    const result = Bun.spawnSync(["which", "bun"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) {
      const path = result.stdout.toString().trim();
      if (path) return path;
    }
  } catch {
    // Fall through
  }

  // 2. Check common locations
  const candidates = [
    "/opt/homebrew/bin/bun", // macOS Apple Silicon (Homebrew)
    "/usr/local/bin/bun", // macOS Intel / Linux Homebrew
    "/usr/bin/bun", // Linux system install
    join(homedir(), ".bun", "bin", "bun"), // Bun self-install
  ];

  if (process.platform === "win32") {
    candidates.push(
      join(process.env.USERPROFILE ?? homedir(), ".bun", "bin", "bun.exe"),
      "bun", // fallback to PATH
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // 3. Fallback
  return process.platform === "win32" ? "bun" : "/usr/local/bin/bun";
}

// ---------------------------------------------------------------------------
// Secure env file writer
// ---------------------------------------------------------------------------

/**
 * Write a secret-bearing env file and restrict permissions to owner-only.
 *
 * @security
 * - File is written with mode 0o600 (owner read/write only).
 * - On Windows, chmod is skipped (not supported).
 * - The master key NEVER appears in service unit files, plist files, or bat scripts.
 */
function writeSecureEnvFile(envFilePath: string, masterKey: string): void {
  const envDir = dirname(envFilePath);
  if (!existsSync(envDir)) {
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(envFilePath, `EIDOLON_MASTER_KEY=${masterKey}\n`, { mode: 0o600 });
  // Belt-and-suspenders: ensure mode is set even if umask interfered
  if (process.platform !== "win32") {
    chmodSync(envFilePath, 0o600);
  }
}

/**
 * Ensure log directory exists with restricted permissions.
 * Returns the absolute path to the log directory.
 */
function ensureLogDir(): string {
  const logDir =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Logs", "Eidolon")
      : join(homedir(), ".local", "share", "eidolon", "logs");

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") {
    chmodSync(logDir, 0o700);
  }
  return logDir;
}

// ---------------------------------------------------------------------------
// macOS LaunchAgent
// ---------------------------------------------------------------------------

function buildPlistContent(envFilePath?: string): string {
  const bunPath = detectBunPath();
  const logDir = ensureLogDir();

  // SEC: Never embed the master key in the plist file.
  // Instead, use a wrapper script that sources the env file before launching.
  // LaunchAgent does not natively support EnvironmentFile, so we reference the
  // env file via a shell wrapper in ProgramArguments.
  const programArgs = envFilePath
    ? `    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>. ${envFilePath} &amp;&amp; exec ${bunPath} run eidolon daemon start --foreground</string>
    </array>`
    : `    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>eidolon</string>
        <string>daemon</string>
        <string>start</string>
        <string>--foreground</string>
    </array>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.eidolon.daemon</string>
    <key>ProgramArguments</key>
${programArgs}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${join(logDir, "eidolon-stdout.log")}</string>
    <key>StandardErrorPath</key>
    <string>${join(logDir, "eidolon-stderr.log")}</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;
}

function installMacOsService(masterKey?: string): boolean {
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, "com.eidolon.daemon.plist");

  try {
    // SEC: Write master key to a separate env file, never in the plist
    let envFilePath: string | undefined;
    if (masterKey) {
      const eidolonConfigDir = join(homedir(), ".config", "eidolon");
      envFilePath = join(eidolonConfigDir, "env");
      writeSecureEnvFile(envFilePath, masterKey);
      console.log(`  Env file written: ${envFilePath} (mode 0600)`);
    }

    if (!existsSync(launchAgentsDir)) {
      mkdirSync(launchAgentsDir, { recursive: true });
    }
    writeFileSync(plistPath, buildPlistContent(envFilePath), "utf-8");
    // SEC: Restrict plist permissions to owner-only
    chmodSync(plistPath, 0o600);
    console.log(`  Created LaunchAgent: ${plistPath} (mode 0600)`);

    // Auto-load the service
    try {
      const loadResult = Bun.spawnSync(["launchctl", "load", plistPath], { stdout: "pipe", stderr: "pipe" });
      if (loadResult.exitCode === 0) {
        console.log("  Service loaded and started automatically.");
      } else {
        const stderr = loadResult.stderr.toString().trim();
        console.log(`  Auto-load failed: ${stderr || "unknown error"}`);
        console.log(`  To load manually: launchctl load ${plistPath}`);
      }
    } catch {
      console.log(`  To load manually: launchctl load ${plistPath}`);
    }
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Failed to install LaunchAgent: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linux systemd user service
// ---------------------------------------------------------------------------

function buildSystemdService(envFilePath?: string): string {
  const bunPath = detectBunPath();
  // SEC: Use EnvironmentFile instead of embedding secrets in the unit file.
  const envLine = envFilePath ? `EnvironmentFile=${envFilePath}\n` : "";
  return `[Unit]
Description=Eidolon AI Assistant Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bunPath} run eidolon daemon start --foreground
ExecStop=/bin/kill -SIGTERM $MAINPID
${envLine}Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

function installLinuxService(masterKey?: string): boolean {
  const systemdDir = join(homedir(), ".config", "systemd", "user");
  const servicePath = join(systemdDir, "eidolon.service");

  try {
    // SEC: Write master key to a separate env file, never in the unit file
    let envFilePath: string | undefined;
    if (masterKey) {
      const eidolonConfigDir = join(homedir(), ".config", "eidolon");
      envFilePath = join(eidolonConfigDir, "env");
      writeSecureEnvFile(envFilePath, masterKey);
      console.log(`  Env file written: ${envFilePath} (mode 0600)`);
    }

    if (!existsSync(systemdDir)) {
      mkdirSync(systemdDir, { recursive: true });
    }
    writeFileSync(servicePath, buildSystemdService(envFilePath), "utf-8");
    // SEC: Restrict service file permissions
    chmodSync(servicePath, 0o600);
    console.log(`  Created systemd user service: ${servicePath} (mode 0600)`);

    // Try to reload systemd
    try {
      Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stdout: "pipe", stderr: "pipe" });
      console.log("  systemd user daemon reloaded.");
    } catch {
      console.log("  Run 'systemctl --user daemon-reload' to reload.");
    }

    // Auto-enable and start
    try {
      const enableResult = Bun.spawnSync(["systemctl", "--user", "enable", "--now", "eidolon"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (enableResult.exitCode === 0) {
        console.log("  Service enabled and started automatically.");
      } else {
        const stderr = enableResult.stderr.toString().trim();
        console.log(`  Auto-start failed: ${stderr || "unknown error"}`);
        console.log("  To enable: systemctl --user enable eidolon");
        console.log("  To start:  systemctl --user start eidolon");
      }
    } catch {
      console.log("  To enable: systemctl --user enable eidolon");
      console.log("  To start:  systemctl --user start eidolon");
    }
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Failed to install systemd service: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Windows startup script
// ---------------------------------------------------------------------------

function buildWindowsScript(envFilePath?: string): string {
  // SEC: Source the env file instead of embedding the master key in the script.
  const envLines = envFilePath
    ? `REM Load environment from secure env file
for /f "usebackq tokens=*" %%a in ("${envFilePath}") do SET %%a
`
    : "";
  return `@echo off
REM Eidolon AI Assistant -- Windows Startup Script
${envLines}start /B bun run eidolon daemon start --foreground
`;
}

function installWindowsService(masterKey?: string): boolean {
  const startupDir = join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  const scriptPath = join(startupDir, "eidolon-startup.bat");

  try {
    // SEC: Write master key to a separate env file, never in the bat script
    let envFilePath: string | undefined;
    if (masterKey) {
      const eidolonDataDir = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "eidolon");
      envFilePath = join(eidolonDataDir, "env");
      if (!existsSync(eidolonDataDir)) {
        mkdirSync(eidolonDataDir, { recursive: true });
      }
      writeFileSync(envFilePath, `EIDOLON_MASTER_KEY=${masterKey}\n`, { mode: 0o600 });
      // Note: chmod is not effective on Windows, but we set mode on write
      console.log(`  Env file written: ${envFilePath}`);
    }

    if (!existsSync(startupDir)) {
      mkdirSync(startupDir, { recursive: true });
    }
    writeFileSync(scriptPath, buildWindowsScript(envFilePath), "utf-8");
    console.log(`  Created startup script: ${scriptPath}`);
    console.log("  Eidolon will start automatically on next login.");
    console.log("  To start now, run: eidolon daemon start --foreground");
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Failed to install startup script: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Platform dispatcher
// ---------------------------------------------------------------------------

export async function installPlatformService(masterKey?: string): Promise<boolean> {
  const platform = process.platform;

  if (platform === "darwin") {
    console.log("  Installing macOS LaunchAgent...");
    return installMacOsService(masterKey);
  }
  if (platform === "linux") {
    console.log("  Installing systemd user service...");
    return installLinuxService(masterKey);
  }
  if (platform === "win32") {
    console.log("  Installing Windows startup script...");
    return installWindowsService(masterKey);
  }

  console.log(`  Platform "${platform}" is not supported for automatic service installation.`);
  console.log("  Start the daemon manually: eidolon daemon start");
  return false;
}
