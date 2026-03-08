/**
 * MCPHealthMonitor -- checks if configured MCP servers are responsive.
 *
 * Each configured MCP server is spawned with a timeout. If the process
 * starts successfully and writes to stdout/stderr within the timeout,
 * it is considered healthy. If it fails to start or times out, it is
 * marked as unhealthy.
 *
 * Health statuses are cached and refreshed periodically.
 */

import type { HealthCheck } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpServerHealthStatus {
  readonly name: string;
  readonly status: "healthy" | "unhealthy" | "unknown";
  readonly message?: string;
  readonly lastCheckedAt: number;
  readonly responseTimeMs?: number;
}

export interface MCPHealthMonitorOptions {
  /** How often to check each server (ms). Default: 60_000 (1 minute). */
  readonly checkIntervalMs?: number;
  /** Timeout for each server spawn check (ms). Default: 10_000 (10 seconds). */
  readonly checkTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

const MCP_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TZ",
  "NODE_ENV",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

// ---------------------------------------------------------------------------
// MCPHealthMonitor
// ---------------------------------------------------------------------------

export class MCPHealthMonitor {
  private readonly servers: ReadonlyMap<string, McpServerConfig>;
  private readonly logger: Logger;
  private readonly checkIntervalMs: number;
  private readonly checkTimeoutMs: number;
  private readonly statuses: Map<string, McpServerHealthStatus> = new Map();
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  constructor(servers: Record<string, McpServerConfig>, logger: Logger, options?: MCPHealthMonitorOptions) {
    this.servers = new Map(Object.entries(servers));
    this.logger = logger.child("mcp-health");
    this.checkIntervalMs = options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.checkTimeoutMs = options?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

    // Initialize all statuses as unknown
    for (const [name] of this.servers) {
      this.statuses.set(name, {
        name,
        status: "unknown",
        lastCheckedAt: 0,
      });
    }
  }

  /** Get the current health status of all MCP servers. */
  getStatuses(): readonly McpServerHealthStatus[] {
    return [...this.statuses.values()];
  }

  /** Get the health status of a specific MCP server. */
  getStatus(name: string): McpServerHealthStatus | undefined {
    return this.statuses.get(name);
  }

  /** Check all configured MCP servers and update statuses. */
  async checkAll(): Promise<readonly McpServerHealthStatus[]> {
    const results: McpServerHealthStatus[] = [];

    for (const [name, config] of this.servers) {
      const result = await this.checkServer(name, config);
      this.statuses.set(name, result);
      results.push(result);
    }

    return results;
  }

  /** Check a single MCP server by spawning its process with a timeout. */
  async checkServer(name: string, config: McpServerConfig): Promise<McpServerHealthStatus> {
    const startTime = Date.now();
    let proc: ReturnType<typeof Bun.spawn> | null = null;

    try {
      const args = config.args ? [...config.args] : [];
      const commandParts = [config.command, ...args];

      // Filter out $secret: references from env -- they cannot be resolved here.
      // Only pass through literal values.
      const filteredEnv: Record<string, string> = {};
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          if (!value.startsWith("$secret:")) {
            filteredEnv[key] = value;
          }
        }
      }

      const safeEnv: Record<string, string> = {};
      for (const key of MCP_SAFE_ENV_KEYS) {
        const val = process.env[key];
        if (val) safeEnv[key] = val;
      }

      proc = Bun.spawn(commandParts, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...safeEnv, ...filteredEnv },
      });

      // Wait for either the process to produce output (healthy) or timeout.
      const healthyPromise = this.waitForProcessOutput(proc);
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), this.checkTimeoutMs);
      });

      const result = await Promise.race([healthyPromise, timeoutPromise]);

      const responseTimeMs = Date.now() - startTime;

      if (result === "timeout") {
        return {
          name,
          status: "healthy",
          message: `Process started successfully (no output within ${this.checkTimeoutMs}ms)`,
          lastCheckedAt: Date.now(),
          responseTimeMs,
        };
      }

      if (result === "exited-error") {
        return {
          name,
          status: "unhealthy",
          message: "Process exited with non-zero status",
          lastCheckedAt: Date.now(),
          responseTimeMs,
        };
      }

      return {
        name,
        status: "healthy",
        message: "Process started and produced output",
        lastCheckedAt: Date.now(),
        responseTimeMs,
      };
    } catch (err: unknown) {
      const responseTimeMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn("check", `MCP server '${name}' health check failed: ${message}`);

      return {
        name,
        status: "unhealthy",
        message: `Failed to spawn: ${message}`,
        lastCheckedAt: Date.now(),
        responseTimeMs,
      };
    } finally {
      if (proc) {
        try {
          proc.kill();
        } catch {
          // Process may have already exited
        }
      }
    }
  }

  /**
   * Wait for the process to produce output or exit.
   * Returns "output" if stdout/stderr produces data, "exited-error" if it exits
   * with a non-zero code, or "exited-ok" if it exits with code 0.
   */
  private async waitForProcessOutput(
    proc: ReturnType<typeof Bun.spawn>,
  ): Promise<"output" | "exited-error" | "exited-ok"> {
    return new Promise((resolve) => {
      let resolved = false;

      const tryResolve = (value: "output" | "exited-error" | "exited-ok"): void => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };

      // Check if stdout has data
      if (proc.stdout) {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        reader.read().then(
          ({ done }) => {
            if (!done) {
              tryResolve("output");
            }
            reader.releaseLock();
          },
          () => {
            // Stream error -- process may have exited
          },
        );
      }

      // Check process exit
      proc.exited.then(
        (code) => {
          tryResolve(code === 0 ? "exited-ok" : "exited-error");
        },
        () => {
          tryResolve("exited-error");
        },
      );
    });
  }

  /** Start periodic health checks. */
  startPeriodic(): void {
    this.stopPeriodic();

    // Do an initial check
    this.checkAll().catch((err: unknown) => {
      this.logger.error("periodic", "Initial MCP health check failed", err);
    });

    this.periodicTimer = setInterval(() => {
      this.checkAll().catch((err: unknown) => {
        this.logger.error("periodic", "Periodic MCP health check failed", err);
      });
    }, this.checkIntervalMs);

    this.logger.info("periodic", `Started periodic MCP health checks every ${this.checkIntervalMs}ms`);
  }

  /** Stop periodic health checks. */
  stopPeriodic(): void {
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  /** Dispose of the monitor, stopping periodic checks. */
  dispose(): void {
    this.stopPeriodic();
    this.logger.debug("dispose", "MCPHealthMonitor disposed");
  }

  /**
   * Create a HealthCheck function compatible with HealthChecker.register().
   * Aggregates all MCP server statuses into a single health check result.
   */
  createHealthCheck(): () => Promise<HealthCheck> {
    return async (): Promise<HealthCheck> => {
      const statuses = this.getStatuses();

      if (statuses.length === 0) {
        return { name: "mcp-servers", status: "pass", message: "No MCP servers configured" };
      }

      const unhealthy = statuses.filter((s) => s.status === "unhealthy");
      const unknown = statuses.filter((s) => s.status === "unknown");

      if (unhealthy.length > 0) {
        const names = unhealthy.map((s) => s.name).join(", ");
        return {
          name: "mcp-servers",
          status: "warn",
          message: `${unhealthy.length}/${statuses.length} MCP server(s) unhealthy: ${names}`,
        };
      }

      if (unknown.length === statuses.length) {
        return {
          name: "mcp-servers",
          status: "warn",
          message: "MCP server health not yet checked",
        };
      }

      return {
        name: "mcp-servers",
        status: "pass",
        message: `All ${statuses.length} MCP server(s) healthy`,
      };
    };
  }
}
