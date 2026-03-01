/**
 * Health check and circuit breaker types for resilience patterns.
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  readonly name: string;
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxAttempts: number;
}

export interface CircuitBreakerStatus {
  readonly name: string;
  readonly state: CircuitState;
  readonly failures: number;
  readonly lastFailureAt?: number;
  readonly lastSuccessAt?: number;
  readonly nextProbeAt?: number;
}

export interface HealthStatus {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly timestamp: number;
  readonly uptime: number;
  readonly checks: readonly HealthCheck[];
}

export interface HealthCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly message?: string;
  readonly duration?: number;
}
