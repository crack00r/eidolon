/**
 * GPUWorker -- single GPU worker abstraction with health tracking and circuit breaker.
 *
 * Wraps a single GPU worker endpoint, providing:
 * - Periodic health checking
 * - Circuit breaker integration for automatic failure detection
 * - Active request tracking for load balancing
 * - Latency tracking for latency-weighted balancing
 * - Authenticated HTTP requests
 */

import type { CircuitBreakerConfig, CircuitState, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { ZodType } from "zod";
import { CircuitBreaker } from "../health/circuit-breaker.ts";
import type { Logger } from "../logging/logger.ts";
import type { GpuHealth } from "./manager.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for a single GPU worker. */
export interface GPUWorkerConfig {
  readonly name: string;
  readonly url: string;
  readonly apiKey?: string;
  readonly capabilities: readonly ("tts" | "stt" | "realtime")[];
  readonly timeoutMs?: number;
  readonly priority?: number;
  readonly maxConcurrent?: number;
  /** Allow connecting to private/internal network addresses. Defaults to true for GPU workers. */
  readonly allowPrivateHosts?: boolean;
}

/** Hostnames that should always be blocked (cloud metadata endpoints + null addresses). */
const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "instance-data", "169.254.169.254", "0.0.0.0", "::"]);

/** Validate a GPU worker URL at construction time. */
function validateGpuWorkerUrl(url: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid GPU worker URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`GPU worker URL must use http or https: ${url}`);
  }
  const hostname = parsed.hostname
    .replace(/^\[/, "")
    .replace(/]$/, "")
    .toLowerCase()
    .replace(/^::ffff:/, "");
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`GPU worker URL rejected: ${hostname} is a blocked hostname (SSRF protection)`);
  }
  if (
    !allowPrivate &&
    (hostname === "localhost" ||
      /^127\./.test(hostname) ||
      /^::1$/.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^fd[0-9a-f]{2}:/.test(hostname) ||
      /^fe80:/.test(hostname))
  ) {
    throw new Error(`GPU worker URL rejected: ${hostname} is a private address (SSRF protection)`);
  }
}

/** Read-only snapshot of a worker's current state. */
export interface GPUWorkerInfo {
  readonly name: string;
  readonly url: string;
  readonly capabilities: readonly ("tts" | "stt" | "realtime")[];
  readonly health: GpuHealth | null;
  readonly circuitState: CircuitState;
  readonly activeRequests: number;
  readonly avgLatencyMs: number;
  readonly lastHealthCheck: number;
}

/** Maximum allowed GPU response size: 100 MB. */
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Default timeout for GPU worker requests in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Expected JSON Content-Type prefix from GPU worker responses. */
const JSON_CONTENT_TYPE_PREFIX = "application/json";

/** Number of latency samples to keep for the moving average. */
const LATENCY_WINDOW_SIZE = 20;

// ---------------------------------------------------------------------------
// GPUWorker
// ---------------------------------------------------------------------------

export class GPUWorker {
  private readonly config: GPUWorkerConfig;
  private readonly logger: Logger;
  private readonly circuitBreaker: CircuitBreaker;
  private health: GpuHealth | null = null;
  private lastHealthCheckAt = 0;
  private _activeRequests = 0;
  private readonly latencySamples: number[] = [];

  constructor(config: GPUWorkerConfig, logger: Logger) {
    validateGpuWorkerUrl(config.url, config.allowPrivateHosts ?? true);
    this.config = config;
    this.logger = logger.child(`gpu-worker:${config.name}`);

    const cbConfig: CircuitBreakerConfig = {
      name: `gpu-worker:${config.name}`,
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      halfOpenMaxAttempts: 3,
    };
    this.circuitBreaker = new CircuitBreaker(cbConfig, this.logger);

    if (this.config.apiKey && this.config.url.startsWith("http://")) {
      this.logger.warn(
        "security",
        "GPU worker URL uses plain HTTP -- API key will be sent unencrypted. Use HTTPS in production.",
        { url: this.config.url },
      );
    }
  }

  /** Get a read-only snapshot of this worker's state. */
  getInfo(): GPUWorkerInfo {
    return {
      name: this.config.name,
      url: this.config.url,
      capabilities: this.config.capabilities,
      health: this.health,
      circuitState: this.circuitBreaker.getStatus().state,
      activeRequests: this._activeRequests,
      avgLatencyMs: this.getAvgLatency(),
      lastHealthCheck: this.lastHealthCheckAt,
    };
  }

  /** The worker's name. */
  get name(): string {
    return this.config.name;
  }

  /** Current active request count. */
  get activeRequests(): number {
    return this._activeRequests;
  }

  /** Whether this worker has capacity for more requests. */
  get hasCapacity(): boolean {
    if (this.config.maxConcurrent === undefined) return true;
    return this._activeRequests < this.config.maxConcurrent;
  }

  /** Check if the GPU worker is reachable and healthy. */
  async checkHealth(): Promise<Result<GpuHealth, EidolonError>> {
    const result = await this.executeRequest<GpuHealth>("/health", { method: "GET" });
    this.lastHealthCheckAt = Date.now();

    if (result.ok) {
      this.health = result.value;
      this.logger.debug("health", "GPU worker healthy", {
        status: result.value.status,
        gpu: result.value.gpu.available ? result.value.gpu.name : "none",
      });
    } else {
      this.health = null;
      this.logger.warn("health", "GPU worker unavailable", {
        error: result.error.message,
      });
    }

    return result;
  }

  /**
   * Execute an authenticated request through the circuit breaker.
   * Tracks active requests and latency for load balancing.
   * When a `schema` is provided, JSON responses are validated against it.
   */
  async executeRequest<T>(
    path: string,
    options?: RequestInit,
    timeoutOverrideMs?: number,
    schema?: ZodType<T>,
  ): Promise<Result<T, EidolonError>> {
    if (!this.hasCapacity) {
      return Err(
        createError(
          ErrorCode.GPU_UNAVAILABLE,
          `GPU worker '${this.config.name}' at max concurrent requests (${this.config.maxConcurrent})`,
        ),
      );
    }

    const startMs = Date.now();
    this._activeRequests++;

    try {
      const cbResult = await this.circuitBreaker.execute(async () => {
        return this.rawRequest<T>(path, options, timeoutOverrideMs, schema);
      });

      if (!cbResult.ok) {
        return cbResult;
      }

      // cbResult.value is the inner Result<T, EidolonError>
      const innerResult = cbResult.value;

      if (innerResult.ok) {
        // Record latency on success
        this.recordLatency(Date.now() - startMs);
      } else {
        // Inner HTTP error should still count as a circuit breaker failure
        this.circuitBreaker.recordFailure();
      }

      return innerResult;
    } finally {
      this._activeRequests--;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async rawRequest<T>(
    path: string,
    options?: RequestInit,
    timeoutOverrideMs?: number,
    schema?: ZodType<T>,
  ): Promise<Result<T, EidolonError>> {
    const url = `${this.config.url}${path}`;
    const timeoutMs = timeoutOverrideMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = new Headers(options?.headers);
    if (this.config.apiKey) {
      headers.set("X-API-Key", this.config.apiKey);
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
        redirect: "error",
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const code =
          response.status === 401 || response.status === 403 ? ErrorCode.GPU_AUTH_FAILED : ErrorCode.GPU_UNAVAILABLE;
        if (response.status === 401 || response.status === 403) {
          this.logger.warn("security", `GPU worker auth failure on ${path}: ${response.status}`, {
            status: response.status,
          });
        }
        return Err(createError(code, `GPU worker '${this.config.name}' returned ${response.status}: ${body}`));
      }

      const bodyBytes = await this.readBodyWithLimit(response, MAX_RESPONSE_BYTES);
      if (!bodyBytes.ok) {
        return Err(bodyBytes.error);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes(JSON_CONTENT_TYPE_PREFIX)) {
        const text = new TextDecoder().decode(bodyBytes.value);
        const data: unknown = JSON.parse(text);
        if (typeof data !== "object" || data === null) {
          return Err(createError(ErrorCode.GPU_UNAVAILABLE, "Invalid GPU response format"));
        }
        if (schema) {
          const parsed = schema.safeParse(data);
          if (!parsed.success) {
            return Err(
              createError(ErrorCode.GPU_UNAVAILABLE, `GPU response validation failed: ${parsed.error.message}`),
            );
          }
          return Ok(parsed.data);
        }
        this.logger.warn("rawRequest", "Returning unvalidated GPU JSON response (no schema provided)", { path });
        return Ok(data as T);
      }

      // Non-JSON response (e.g. audio): validate Content-Type and minimum size
      if (!contentType || contentType === "application/octet-stream" || contentType.startsWith("audio/")) {
        if (bodyBytes.value.byteLength < 1) {
          return Err(createError(ErrorCode.GPU_UNAVAILABLE, "GPU returned empty binary response"));
        }
      } else {
        return Err(createError(ErrorCode.GPU_UNAVAILABLE, `Unexpected GPU response Content-Type: ${contentType}`));
      }

      const data = bodyBytes.value.buffer.slice(
        bodyBytes.value.byteOffset,
        bodyBytes.value.byteOffset + bodyBytes.value.byteLength,
      ) as T;
      return Ok(data);
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return Err(createError(ErrorCode.GPU_UNAVAILABLE, "Invalid JSON in GPU response"));
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        return Err(createError(ErrorCode.TIMEOUT, `GPU worker request to ${path} timed out after ${timeoutMs}ms`));
      }
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.GPU_UNAVAILABLE, `GPU worker request to ${path} failed: ${message}`, err));
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBodyWithLimit(response: Response, maxBytes: number): Promise<Result<Uint8Array, EidolonError>> {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const size = Number(contentLength);
      if (!Number.isNaN(size) && size > maxBytes) {
        return Err(createError(ErrorCode.GPU_UNAVAILABLE, `GPU response too large: ${size} bytes (max ${maxBytes})`));
      }
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return Ok(new Uint8Array(0));
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          reader.cancel().catch((e: unknown) => this.logger.debug("gpu", "reader cancel failed", { error: String(e) }));
          return Err(
            createError(ErrorCode.GPU_UNAVAILABLE, `GPU response too large: exceeded ${maxBytes} bytes (streamed)`),
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    if (chunks.length === 1) {
      const single = chunks[0];
      if (single === undefined) return Err(createError(ErrorCode.GPU_UNAVAILABLE, "unexpected empty chunk"));
      return Ok(single);
    }
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Ok(result);
  }

  private recordLatency(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > LATENCY_WINDOW_SIZE) {
      this.latencySamples.shift();
    }
  }

  private getAvgLatency(): number {
    if (this.latencySamples.length === 0) return 0;
    const sum = this.latencySamples.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.latencySamples.length);
  }
}
