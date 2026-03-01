/**
 * eidolon daemon start|stop|status -- daemon management.
 * Only `status` is implemented in Phase 0; start/stop are Phase 3 stubs.
 */

import { existsSync, readFileSync } from "node:fs";
import { getPidFilePath } from "@eidolon/core";
import type { Command } from "commander";

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

export function registerDaemonCommand(program: Command): void {
  const cmd = program.command("daemon").description("Manage the Eidolon daemon");

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

  cmd
    .command("start")
    .description("Start the Eidolon daemon")
    .action(() => {
      console.log("Not yet implemented -- Phase 3");
    });

  cmd
    .command("stop")
    .description("Stop the Eidolon daemon")
    .action(() => {
      console.log("Not yet implemented -- Phase 3");
    });
}
