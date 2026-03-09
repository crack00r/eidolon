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
  /** ERR-004: Track periodic check timer for cleanup on stop/dispose. */
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  /** ERR-004: Track check timeout timers for cleanup. */
  private readonly activeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

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
      // ERR-004: Track timeout timer so it can be cleaned up on dispose
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (timer) this.activeTimeouts.delete(timer);
            reject(new Error(`Health check '${registered.name}' timed out after ${CHECK_TIMEOUT_MS}ms`));
          }, CHECK_TIMEOUT_MS);
          this.activeTimeouts.add(timer);
        });
        const result = await Promise.race([registered.check(), timeout]);
        results.push(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name: registered.name, status: "fail", message });
      } finally {
        // Always clean up the timeout timer after the race settles
        if (timer !== null) {
          clearTimeout(timer);
          this.activeTimeouts.delete(timer);
        }
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

  /**
   * ERR-004: Start periodic health checks at the given interval.
   * Returns the checker for chaining.
   */
  startPeriodic(intervalMs: number): HealthChecker {
    this.stopPeriodic();
    this.periodicTimer = setInterval(() => {
      this.check().catch((err: unknown) => {
        this.logger.error("health", "Periodic health check failed", err);
      });
    }, intervalMs);
    this.periodicTimer.unref();
    this.logger.debug("health", `Started periodic health checks every ${intervalMs}ms`);
    return this;
  }

  /** ERR-004: Stop periodic health checks. */
  stopPeriodic(): void {
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  /** ERR-004: Dispose of the health checker, clearing all timers. */
  dispose(): void {
    this.stopPeriodic();
    for (const timer of this.activeTimeouts) {
      clearTimeout(timer);
    }
    this.activeTimeouts.clear();
    this.logger.debug("health", "Health checker disposed");
  }
}
