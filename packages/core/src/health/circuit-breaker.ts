/**
 * Generic circuit breaker pattern implementation.
 *
 * States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED (or back to OPEN)
 *
 * CLOSED:    Requests pass through. Track failures. When failures >= threshold -> OPEN.
 * OPEN:      All requests fail immediately with CIRCUIT_OPEN. After resetTimeout -> HALF_OPEN.
 * HALF_OPEN: Allow one probe request. Success -> CLOSED. Failure -> OPEN.
 */

import type { CircuitBreakerConfig, CircuitBreakerStatus, CircuitState, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailureAt: number | undefined;
  private lastSuccessAt: number | undefined;
  private readonly config: CircuitBreakerConfig;
  private readonly logger: Logger;

  constructor(config: CircuitBreakerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child("circuit-breaker");
  }

  /** Execute a function through the circuit breaker. */
  async execute<T>(fn: () => Promise<T>): Promise<Result<T, EidolonError>> {
    if (this.state === "open") {
      const now = Date.now();
      const nextProbe = (this.lastFailureAt ?? 0) + this.config.resetTimeoutMs;

      if (now >= nextProbe) {
        this.transitionTo("half_open");
      } else {
        return Err(
          createError(
            ErrorCode.CIRCUIT_OPEN,
            `Circuit breaker '${this.config.name}' is open. Next probe at ${nextProbe}`,
          ),
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return Ok(result);
    } catch (err: unknown) {
      this.onFailure();
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.TIMEOUT, `Circuit '${this.config.name}' call failed: ${message}`, err));
    }
  }

  /** Get current circuit breaker status. */
  getStatus(): CircuitBreakerStatus {
    const status: CircuitBreakerStatus = {
      name: this.config.name,
      state: this.state,
      failures: this.failures,
      ...(this.lastFailureAt !== undefined ? { lastFailureAt: this.lastFailureAt } : {}),
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.state === "open" && this.lastFailureAt !== undefined
        ? { nextProbeAt: this.lastFailureAt + this.config.resetTimeoutMs }
        : {}),
    };
    return status;
  }

  /** Manually reset to closed state. */
  reset(): void {
    this.failures = 0;
    this.lastFailureAt = undefined;
    this.transitionTo("closed");
  }

  private onSuccess(): void {
    this.lastSuccessAt = Date.now();

    if (this.state === "half_open") {
      this.failures = 0;
      this.transitionTo("closed");
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures += 1;
    this.lastFailureAt = Date.now();

    if (this.state === "half_open") {
      this.transitionTo("open");
    } else if (this.failures >= this.config.failureThreshold) {
      this.transitionTo("open");
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.logger.info("transition", `${this.config.name}: ${oldState} -> ${newState}`, {
      failures: this.failures,
    });
  }
}
