/**
 * Health checker that runs multiple registered checks and aggregates results.
 *
 * Rules:
 * - All pass  -> "healthy"
 * - Any warn but no fail -> "degraded"
 * - Any fail  -> "unhealthy"
 */

import type { HealthCheck, HealthStatus } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

interface RegisteredCheck {
  readonly name: string;
  readonly check: () => Promise<HealthCheck>;
}

/** Per-check timeout in milliseconds. */
const CHECK_TIMEOUT_MS = 5_000;

export class HealthChecker {
  private readonly checks: RegisteredCheck[] = [];
  private readonly logger: Logger;
  private readonly startTime: number;

  constructor(logger: Logger) {
    this.logger = logger.child("health");
    this.startTime = Date.now();
  }

  /** Register a named health check. */
  register(name: string, check: () => Promise<HealthCheck>): void {
    this.checks.push({ name, check });
    this.logger.debug("register", `Registered health check: ${name}`);
  }

  /** Run all checks and return aggregated status. */
  async check(): Promise<HealthStatus> {
    const results: HealthCheck[] = [];

    for (const registered of this.checks) {
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Health check '${registered.name}' timed out after ${CHECK_TIMEOUT_MS}ms`)),
            CHECK_TIMEOUT_MS,
          ),
        );
        const result = await Promise.race([registered.check(), timeout]);
        results.push(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name: registered.name, status: "fail", message });
      }
    }

    const hasFail = results.some((r) => r.status === "fail");
    const hasWarn = results.some((r) => r.status === "warn");

    const status: HealthStatus["status"] = hasFail ? "unhealthy" : hasWarn ? "degraded" : "healthy";

    return {
      status,
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime,
      checks: results,
    };
  }
}
