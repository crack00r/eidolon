/**
 * GPU Worker manager — discovery and health monitoring.
 *
 * Wraps communication with a GPU worker (Python/FastAPI service).
 * Provides health checking, availability tracking, and authenticated requests.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import { injectTraceContext } from "../telemetry/propagation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GpuWorkerConfig {
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

export interface GpuHealth {
  readonly status: string;
  readonly uptimeSeconds: number;
  readonly gpu: {
    readonly available: boolean;
    readonly name?: string;
    readonly vramTotalMb?: number;
    readonly vramUsedMb?: number;
    readonly temperatureC?: number;
    readonly utilizationPct?: number;
  };
  readonly modelsLoaded: readonly string[];
}

/** Default timeout for GPU worker requests in ms. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum allowed GPU response size: 100 MB. */
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Expected JSON Content-Type prefix from GPU worker responses. */
const JSON_CONTENT_TYPE_PREFIX = "application/json";

// ---------------------------------------------------------------------------
// GPUManager
// ---------------------------------------------------------------------------

export class GPUManager {
  private readonly config: GpuWorkerConfig;
  private readonly logger: Logger;
  private readonly tracer: ITracer;
  private available = false;

  constructor(config: GpuWorkerConfig, logger: Logger, tracer?: ITracer) {
    this.config = config;
    this.logger = logger.child("gpu-manager");
    this.tracer = tracer ?? new NoopTracer();

    // Finding #1: Warn if GPU API key may be sent over plain HTTP
    if (this.config.apiKey && this.config.url.startsWith("http://")) {
      this.logger.warn(
        "security",
        "GPU worker URL uses plain HTTP — API key will be sent unencrypted. Use HTTPS in production.",
        { url: this.config.url },
      );
    }
  }

  /** Check if the GPU worker is reachable and healthy. */
  async checkHealth(): Promise<Result<GpuHealth, EidolonError>> {
    const span = this.tracer.startSpan("gpu.health_check", {
      "gpu.url": this.config.url,
    });

    const result = await this.request<GpuHealth>("/health", { method: "GET" });

    if (result.ok) {
      this.available = true;
      span.setAttribute("gpu.status", result.value.status);
      span.setAttribute("gpu.available", result.value.gpu.available);
      span.setStatus("ok");
      this.logger.debug("health", "GPU worker healthy", {
        status: result.value.status,
        gpu: result.value.gpu.available ? result.value.gpu.name : "none",
      });
    } else {
      this.available = false;
      span.setStatus("error", result.error.message);
      this.logger.warn("health", "GPU worker unavailable", {
        error: result.error.message,
      });
    }

    span.end();
    return result;
  }

  /** Get whether the worker is available (based on last health check). */
  get isAvailable(): boolean {
    return this.available;
  }

  /** Get the base URL of the worker. */
  get baseUrl(): string {
    return this.config.url;
  }

  /** Make an authenticated request to the worker. */
  async request<T>(path: string, options?: RequestInit, timeoutOverrideMs?: number): Promise<Result<T, EidolonError>> {
    const url = `${this.config.url}${path}`;
    const timeoutMs = timeoutOverrideMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = new Headers(options?.headers);
    if (this.config.apiKey) {
      headers.set("X-API-Key", this.config.apiKey);
    }

    // Inject trace context for cross-service distributed tracing
    const traceHeaders: Record<string, string> = {};
    injectTraceContext(this.tracer, traceHeaders);
    for (const [key, value] of Object.entries(traceHeaders)) {
      headers.set(key, value);
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
        // Log auth failures as security-relevant events
        if (response.status === 401 || response.status === 403) {
          this.logger.warn("security", `GPU worker auth failure on ${path}: ${response.status}`, {
            status: response.status,
          });
        }
        return Err(createError(code, `GPU worker returned ${response.status}: ${body}`));
      }

      // Reject responses exceeding MAX_RESPONSE_BYTES.
      // When Content-Length is present, reject immediately. Otherwise,
      // stream the body with a byte counter to guard against chunked
      // transfer-encoding responses that omit Content-Length.
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const size = Number(contentLength);
        if (!Number.isNaN(size) && size > MAX_RESPONSE_BYTES) {
          return Err(
            createError(ErrorCode.GPU_UNAVAILABLE, `GPU response too large: ${size} bytes (max ${MAX_RESPONSE_BYTES})`),
          );
        }
      }

      // Read the body via streaming reader with byte limit enforcement
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
        return Ok(data as T);
      }

      // For non-JSON responses (e.g. audio bytes), return the raw ArrayBuffer
      // Callers that expect binary should cast appropriately
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

  /**
   * Read response body with a strict byte limit.
   * Uses a streaming reader to enforce the limit even when
   * Content-Length is absent (e.g. chunked transfer-encoding).
   */
  private async readBodyWithLimit(response: Response, maxBytes: number): Promise<Result<Uint8Array, EidolonError>> {
    const reader = response.body?.getReader();
    if (!reader) {
      // No body — return empty
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
          reader.cancel().catch(() => {});
          return Err(
            createError(ErrorCode.GPU_UNAVAILABLE, `GPU response too large: exceeded ${maxBytes} bytes (streamed)`),
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Concatenate chunks into a single Uint8Array
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
}
