/**
 * Health check: available disk space.
 *
 * Uses `df` on Unix and `wmic` on Windows to check free space in the target directory.
 * Warns if < 500 MB free, fails if < 100 MB free.
 *
 * Security: validates all inputs before passing to shell commands to prevent injection.
 * Uses Bun.spawnSync with array args (no shell interpolation).
 */

import { resolve } from "node:path";
import type { HealthCheck } from "@eidolon/protocol";

const WARN_THRESHOLD_MB = 500;
const FAIL_THRESHOLD_MB = 100;

/**
 * Validate a Windows drive letter (e.g., "C:").
 * Only uppercase ASCII letter followed by colon is accepted.
 */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:$/;

/**
 * Validate a Unix path contains no shell metacharacters that could cause injection.
 * Allows alphanumeric, slash, dot, dash, underscore, tilde, and space.
 */
const UNIX_SAFE_PATH_PATTERN = /^[a-zA-Z0-9/.\-_ ~]+$/;

/** Create a health check that monitors available disk space in `directory`. */
export function createDiskCheck(directory: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => {
    try {
      const freeMb = getDiskFreeMb(directory);

      if (freeMb === null) {
        return {
          name: "disk",
          status: "warn",
          message: "Could not determine free disk space",
        };
      }

      if (freeMb < FAIL_THRESHOLD_MB) {
        return {
          name: "disk",
          status: "fail",
          message: `Only ${freeMb} MB free (minimum: ${FAIL_THRESHOLD_MB} MB)`,
        };
      }

      if (freeMb < WARN_THRESHOLD_MB) {
        return {
          name: "disk",
          status: "warn",
          message: `Low disk space: ${freeMb} MB free (threshold: ${WARN_THRESHOLD_MB} MB)`,
        };
      }

      return {
        name: "disk",
        status: "pass",
        message: `${freeMb} MB free`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { name: "disk", status: "warn", message: `Disk check error: ${message}` };
    }
  };
}

function getDiskFreeMb(directory: string): number | null {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    return getDiskFreeMbWindows(directory);
  }

  return getDiskFreeMbUnix(directory);
}

function getDiskFreeMbUnix(directory: string): number | null {
  // Canonicalize and validate the path to prevent shell metacharacter injection
  const canonical = resolve(directory);
  if (!UNIX_SAFE_PATH_PATTERN.test(canonical)) {
    return null;
  }

  const result = Bun.spawnSync(["df", "-m", canonical], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return null;

  const lines = result.stdout.toString().trim().split("\n");
  // Second line contains the data; 4th column is "Available"
  const dataLine = lines[1];
  if (!dataLine) return null;

  const columns = dataLine.split(/\s+/);
  const available = Number.parseInt(columns[3] ?? "", 10);
  return Number.isFinite(available) ? available : null;
}

function getDiskFreeMbWindows(directory: string): number | null {
  // Extract and strictly validate the drive letter to prevent command injection
  const drive = directory.slice(0, 2).toUpperCase(); // e.g. "C:"
  if (!WINDOWS_DRIVE_PATTERN.test(drive)) {
    return null;
  }

  // Use array args with Bun.spawnSync (no shell interpolation).
  // The drive letter is validated above to be exactly "[A-Z]:" so it's safe.
  const result = Bun.spawnSync(["wmic", "logicaldisk", "where", `DeviceID='${drive}'`, "get", "FreeSpace", "/value"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) return null;

  const match = result.stdout.toString().match(/FreeSpace=(\d+)/);
  if (!match?.[1]) return null;

  const freeBytes = Number.parseInt(match[1], 10);
  return Number.isFinite(freeBytes) ? Math.floor(freeBytes / (1024 * 1024)) : null;
}
