/**
 * GPU Worker manager — discovery and health monitoring.
 *
 * Wraps communication with a GPU worker (Python/FastAPI service).
 * Provides health checking, availability tracking, and authenticated requests.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { type ZodType, z } from "zod";
import type { Logger } from "../logging/logger.ts";
import { injectTraceContext } from "../telemetry/propagation.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import type { TtsRequest, TtsResult } from "./tts-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GpuWorkerConfig {
  readonly url: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Allow connecting to private/internal network addresses. Defaults to true for GPU workers. */
  readonly allowPrivateHosts?: boolean;
}

/** Hostnames that should always be blocked (cloud metadata endpoints + null addresses). */
const BLOCKED_GPU_HOSTNAMES = new Set([
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
  "0.0.0.0",
  "::",
]);

/** Validate a GPU manager URL at construction time. */
function validateGpuManagerUrl(url: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid GPU worker URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`GPU worker URL must use http or https: ${url}`);
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/]$/, "").toLowerCase().replace(/^::ffff:/, "");
  if (BLOCKED_GPU_HOSTNAMES.has(hostname)) {
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

/** Zod schema for validating GPU health check responses. */
const GpuHealthSchema = z.object({
  status: z.string(),
  uptimeSeconds: z.number(),
  gpu: z.object({
    available: z.boolean(),
    name: z.string().optional(),
    vramTotalMb: z.number().optional(),
    vramUsedMb: z.number().optional(),
    temperatureC: z.number().optional(),
    utilizationPct: z.number().optional(),
  }),
  modelsLoaded: z.array(z.string()),
});

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
    validateGpuManagerUrl(config.url, config.allowPrivateHosts ?? true);
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

    const result = await this.request<GpuHealth>("/health", { method: "GET" }, undefined, GpuHealthSchema);

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

  /**
   * Synthesize text to speech via the GPU worker's TTS endpoint.
   * Convenience method wrapping request() with proper payload serialization
   * and audio response handling.
   */
  async synthesize(request: TtsRequest): Promise<Result<TtsResult, EidolonError>> {
    if (!this.available) {
      return Err(createError(ErrorCode.GPU_UNAVAILABLE, "GPU worker is not available for TTS"));
    }

    const span = this.tracer.startSpan("gpu.tts_synthesize", {
      "tts.text_length": request.text.length,
      "tts.voice": request.voice ?? "default",
      "tts.format": request.format ?? "opus",
    });

    const startMs = Date.now();

    const body = JSON.stringify({
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      format: request.format ?? "opus",
    });

    const result = await this.request<ArrayBuffer>("/tts/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!result.ok) {
      span.setStatus("error", result.error.message);
      span.end();
      return Err(createError(ErrorCode.TTS_FAILED, `TTS synthesis failed: ${result.error.message}`));
    }

    const audio = new Uint8Array(result.value);
    const durationMs = Date.now() - startMs;

    span.setAttribute("tts.audio_bytes", audio.byteLength);
    span.setAttribute("tts.duration_ms", durationMs);
    span.setStatus("ok");
    span.end();

    this.logger.debug("synthesize", "TTS completed", {
      textLength: request.text.length,
      audioBytes: audio.byteLength,
      durationMs,
    });

    return Ok({ audio, format: request.format ?? "opus", durationMs });
  }

  /** Make an authenticated request to the worker. When a `schema` is provided, JSON responses are validated. */
  async request<T>(
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
        if (schema) {
          const parsed = schema.safeParse(data);
          if (!parsed.success) {
            return Err(
              createError(ErrorCode.GPU_UNAVAILABLE, `GPU response validation failed: ${parsed.error.message}`),
            );
          }
          return Ok(parsed.data);
        }
        this.logger.warn("request", "Returning unvalidated GPU JSON response (no schema provided)", { path });
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

      // For non-JSON responses (e.g. audio bytes), return the raw ArrayBuffer
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
