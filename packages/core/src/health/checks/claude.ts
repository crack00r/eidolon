/**
 * Health check: Claude Code CLI availability.
 *
 * Checks if the `claude` CLI is installed and reachable via `claude --version`.
 */

import type { HealthCheck } from "@eidolon/protocol";

/** Create a health check that verifies Claude Code CLI availability. */
export function createClaudeCheck(): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => {
    try {
      const result = Bun.spawnSync(["claude", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode === 0) {
        const version = result.stdout.toString().trim();
        return { name: "claude", status: "pass", message: `Claude CLI: ${version}` };
      }

      return {
        name: "claude",
        status: "warn",
        message: "Claude CLI returned non-zero exit code",
      };
    } catch {
      return {
        name: "claude",
        status: "warn",
        message: "Claude CLI not found in PATH",
      };
    }
  };
}
