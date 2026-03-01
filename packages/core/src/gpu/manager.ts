/**
 * GPU Worker manager — discovery and health monitoring.
 *
 * Wraps communication with a GPU worker (Python/FastAPI service).
 * Provides health checking, availability tracking, and authenticated requests.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

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
  private available = false;

  constructor(config: GpuWorkerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child("gpu-manager");

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
    const result = await this.request<GpuHealth>("/health", { method: "GET" });

    if (result.ok) {
      this.available = true;
      this.logger.debug("health", "GPU worker healthy", {
        status: result.value.status,
        gpu: result.value.gpu.available ? result.value.gpu.name : "none",
      });
    } else {
      this.available = false;
      this.logger.warn("health", "GPU worker unavailable", {
        error: result.error.message,
      });
    }

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

      // Finding #5: Reject responses exceeding 100 MB
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const size = Number(contentLength);
        if (!Number.isNaN(size) && size > MAX_RESPONSE_BYTES) {
          return Err(
            createError(ErrorCode.GPU_UNAVAILABLE, `GPU response too large: ${size} bytes (max ${MAX_RESPONSE_BYTES})`),
          );
        }
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes(JSON_CONTENT_TYPE_PREFIX)) {
        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null) {
          return Err(createError(ErrorCode.GPU_UNAVAILABLE, "Invalid GPU response format"));
        }
        return Ok(data as T);
      }

      // For non-JSON responses (e.g. audio bytes), return the raw ArrayBuffer
      // Callers that expect binary should cast appropriately
      const data = (await response.arrayBuffer()) as T;
      return Ok(data);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return Err(createError(ErrorCode.TIMEOUT, `GPU worker request to ${path} timed out after ${timeoutMs}ms`));
      }
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.GPU_UNAVAILABLE, `GPU worker request to ${path} failed: ${message}`, err));
    } finally {
      clearTimeout(timer);
    }
  }
}
