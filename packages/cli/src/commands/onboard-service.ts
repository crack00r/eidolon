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
// macOS LaunchAgent
// ---------------------------------------------------------------------------

const PLIST_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.eidolon.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/bun</string>
        <string>run</string>
        <string>eidolon</string>
        <string>daemon</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
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

function installMacOsService(): boolean {
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, "com.eidolon.daemon.plist");

  try {
    if (!existsSync(launchAgentsDir)) {
      mkdirSync(launchAgentsDir, { recursive: true });
    }
    writeFileSync(plistPath, PLIST_CONTENT, "utf-8");
    console.log(`  Created LaunchAgent: ${plistPath}`);
    console.log(`  To load now: launchctl load ${plistPath}`);
    console.log(`  To unload:   launchctl unload ${plistPath}`);
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

const SYSTEMD_USER_SERVICE = `[Unit]
Description=Eidolon AI Assistant Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/bun run eidolon daemon start --foreground
ExecStop=/bin/kill -SIGTERM $MAINPID
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;

function installLinuxService(): boolean {
  const systemdDir = join(homedir(), ".config", "systemd", "user");
  const servicePath = join(systemdDir, "eidolon.service");

  try {
    if (!existsSync(systemdDir)) {
      mkdirSync(systemdDir, { recursive: true });
    }
    writeFileSync(servicePath, SYSTEMD_USER_SERVICE, "utf-8");
    console.log(`  Created systemd user service: ${servicePath}`);
    console.log("  To enable: systemctl --user enable eidolon");
    console.log("  To start:  systemctl --user start eidolon");
    console.log("  To stop:   systemctl --user stop eidolon");

    // Try to reload systemd
    try {
      Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stdout: "pipe", stderr: "pipe" });
      console.log("  systemd user daemon reloaded.");
    } catch {
      console.log("  Run 'systemctl --user daemon-reload' to reload.");
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

const WINDOWS_STARTUP_SCRIPT = `@echo off
REM Eidolon AI Assistant -- Windows Startup Script
REM Place in shell:startup folder or run as scheduled task
start /B bun run eidolon daemon start --foreground
`;

function installWindowsService(): boolean {
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
    writeFileSync(scriptPath, WINDOWS_STARTUP_SCRIPT, "utf-8");
    console.log(`  Created startup script: ${scriptPath}`);
    console.log("  Eidolon will start automatically on login.");
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

export async function installPlatformService(): Promise<boolean> {
  const platform = process.platform;

  if (platform === "darwin") {
    console.log("  Installing macOS LaunchAgent...");
    return installMacOsService();
  }
  if (platform === "linux") {
    console.log("  Installing systemd user service...");
    return installLinuxService();
  }
  if (platform === "win32") {
    console.log("  Installing Windows startup script...");
    return installWindowsService();
  }

  console.log(`  Platform "${platform}" is not supported for automatic service installation.`);
  console.log("  Start the daemon manually: eidolon daemon start");
  return false;
}
