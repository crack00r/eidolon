/**
 * Health checker that runs multiple registered checks and aggregates results.
 *
 * Rules:
 * - All pass  -> "healthy"
 * - Any warn but no fail -> "degraded"
 * - Any fail  -> "unhealthy"
 */

import type { HealthCheck, HealthStatus } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

interface RegisteredCheck {
  readonly name: string;
  readonly check: () => Promise<HealthCheck>;
}

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
        const result = await registered.check();
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
