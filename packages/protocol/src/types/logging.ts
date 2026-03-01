/**
 * Structured logging types.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly level: LogLevel;
  readonly timestamp: number;
  readonly module: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
  readonly error?: {
    readonly message: string;
    readonly stack?: string;
    readonly code?: string;
  };
  readonly traceId?: string;
}
