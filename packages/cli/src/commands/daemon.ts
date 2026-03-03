/**
 * eidolon daemon start|stop|status -- daemon management.
 * Phase 9: full start/stop implementation.
 */

import { existsSync, readFileSync } from "node:fs";
import { getPidFilePath } from "@eidolon/core";
import type { Command } from "commander";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDaemonRunning(): { running: boolean; pid?: number } {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) {
    return { running: false };
  }
  const pidStr = readFileSync(pidFile, "utf-8").trim();
  const pid = Number.parseInt(pidStr, 10);
  if (Number.isNaN(pid)) {
    return { running: false };
  }
  try {
    // Signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/** Wait for a PID to exit, polling at intervalMs. Returns true if exited. */
async function waitForExit(pid: number, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      // Process no longer exists
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDaemonCommand(program: Command): void {
  const cmd = program.command("daemon").description("Manage the Eidolon daemon");

  // -- status ---------------------------------------------------------------

  cmd
    .command("status")
    .description("Check if the daemon is running")
    .action(() => {
      const result = isDaemonRunning();
      if (result.running) {
        console.log(`Eidolon daemon is running (PID: ${result.pid})`);
      } else {
        console.log("Eidolon daemon is not running.");
      }
    });

  // -- start ----------------------------------------------------------------

  cmd
    .command("start")
    .description("Start the Eidolon daemon")
    .option("--foreground", "Run in foreground (do not daemonize)", false)
    .option("--config <path>", "Path to configuration file")
    .action(async (opts: { foreground: boolean; config?: string }) => {
      // Check if already running
      const status = isDaemonRunning();
      if (status.running) {
        console.error(`Eidolon daemon is already running (PID: ${status.pid})`);
        process.exitCode = 1;
        return;
      }

      if (opts.foreground) {
        // Foreground mode: run in this process
        await startForeground(opts.config);
      } else {
        // Background mode: spawn detached child
        startBackground(opts.config);
      }
    });

  // -- stop -----------------------------------------------------------------

  cmd
    .command("stop")
    .description("Stop the Eidolon daemon")
    .option("--timeout <ms>", "Graceful shutdown timeout in milliseconds", "15000")
    .action(async (opts: { timeout: string }) => {
      const status = isDaemonRunning();
      if (!status.running || status.pid === undefined) {
        console.log("Eidolon daemon is not running.");
        return;
      }

      const pid = status.pid;
      const timeoutMs = Number.parseInt(opts.timeout, 10) || 15_000;

      console.log(`Sending termination signal to daemon (PID: ${pid})...`);
      try {
        if (process.platform === "win32") {
          // On Windows, process.kill(pid, "SIGTERM") does not gracefully signal.
          // Use taskkill which sends WM_CLOSE, allowing the process to shut down.
          Bun.spawnSync(["taskkill", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch {
        console.error(`Failed to send termination signal to PID ${pid}. Process may have already exited.`);
        return;
      }

      console.log(`Waiting up to ${timeoutMs}ms for graceful shutdown...`);
      const exited = await waitForExit(pid, timeoutMs);

      if (exited) {
        console.log("Eidolon daemon stopped.");
      } else {
        console.log("Daemon did not exit in time. Force-killing...");
        try {
          if (process.platform === "win32") {
            Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch {
          // Already exited between check and kill
        }
        const killed = await waitForExit(pid, 5_000);
        if (killed) {
          console.log("Eidolon daemon force-killed.");
        } else {
          console.error(`Failed to stop daemon (PID: ${pid}). Manual intervention required.`);
          process.exitCode = 1;
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Start modes
// ---------------------------------------------------------------------------

async function startForeground(configPath?: string): Promise<void> {
  // Dynamic import to avoid loading core modules for status/stop commands
  const { EidolonDaemon } = await import("@eidolon/core");

  const daemon = new EidolonDaemon();

  console.log("Starting Eidolon daemon in foreground mode...");

  try {
    await daemon.start({ configPath, foreground: true });
    console.log("Eidolon daemon is running. Press Ctrl+C to stop.");

    // Keep the process alive. Signal handlers in EidolonDaemon
    // will trigger shutdown on SIGTERM/SIGINT.
    await new Promise<void>(() => {
      // Intentionally never resolves -- daemon runs until signal
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start daemon: ${message}`);
    process.exitCode = 1;
  }
}

/** ERR-003: Env whitelist for daemon spawn — only pass safe env vars to child process. */
function buildSafeDaemonEnv(): Record<string, string> {
  const SAFE_PREFIXES = ["EIDOLON_", "NODE_", "BUN_", "XDG_"];
  const SAFE_KEYS = new Set([
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "TERM",
    "SHELL",
    "TMPDIR",
    "TZ",
    "LC_ALL",
    "LC_CTYPE",
    "NODE_ENV",
    // Windows-specific environment variables needed for correct path resolution
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "COMSPEC",
    "TEMP",
    "TMP",
  ]);

  const safeEnv: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue;
    if (SAFE_KEYS.has(key) || SAFE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      safeEnv[key] = val;
    }
  }
  return safeEnv;
}

function startBackground(configPath?: string): void {
  // Spawn this CLI as a detached child in foreground mode
  const args = ["eidolon", "daemon", "start", "--foreground"];
  if (configPath) {
    args.push("--config", configPath);
  }

  try {
    // ERR-003: Use filtered env instead of raw process.env
    const proc = Bun.spawn(["bun", "run", ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: buildSafeDaemonEnv(),
    });

    // Detach from parent so parent can exit
    proc.unref();

    console.log(`Eidolon daemon starting in background (PID: ${proc.pid})...`);
    console.log("Use 'eidolon daemon status' to check if it started successfully.");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to spawn daemon process: ${message}`);
    process.exitCode = 1;
  }
}
