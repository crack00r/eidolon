/**
 * Platform service installation helper for onboard wizard.
 *
 * Installs Eidolon as a system service:
 * - macOS: LaunchAgent plist
 * - Linux: systemd user service
 * - Windows: startup script or scheduled task
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
// macOS LaunchAgent
// ---------------------------------------------------------------------------

function buildPlistContent(masterKey?: string): string {
  const bunPath = detectBunPath();
  const envSection = masterKey
    ? `
    <key>EnvironmentVariables</key>
    <dict>
        <key>EIDOLON_MASTER_KEY</key>
        <string>${masterKey}</string>
    </dict>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.eidolon.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>run</string>
        <string>eidolon</string>
        <string>daemon</string>
        <string>start</string>
        <string>--foreground</string>
    </array>${envSection}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/eidolon-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/eidolon-stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;
}

function installMacOsService(masterKey?: string): boolean {
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, "com.eidolon.daemon.plist");

  try {
    if (!existsSync(launchAgentsDir)) {
      mkdirSync(launchAgentsDir, { recursive: true });
    }
    writeFileSync(plistPath, buildPlistContent(masterKey), "utf-8");
    console.log(`  Created LaunchAgent: ${plistPath}`);

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

function buildSystemdService(masterKey?: string): string {
  const bunPath = detectBunPath();
  const envLine = masterKey ? `Environment=EIDOLON_MASTER_KEY=${masterKey}\n` : "";
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
    if (!existsSync(systemdDir)) {
      mkdirSync(systemdDir, { recursive: true });
    }
    writeFileSync(servicePath, buildSystemdService(masterKey), "utf-8");
    console.log(`  Created systemd user service: ${servicePath}`);

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

function buildWindowsScript(masterKey?: string): string {
  const envLine = masterKey ? `SET EIDOLON_MASTER_KEY=${masterKey}\n` : "";
  return `@echo off
REM Eidolon AI Assistant -- Windows Startup Script
${envLine}start /B bun run eidolon daemon start --foreground
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
    if (!existsSync(startupDir)) {
      mkdirSync(startupDir, { recursive: true });
    }
    writeFileSync(scriptPath, buildWindowsScript(masterKey), "utf-8");
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
