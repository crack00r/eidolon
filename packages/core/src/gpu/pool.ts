/**
 * GPUWorkerPool -- multi-worker management with load balancing and failover.
 *
 * Manages a pool of GPU workers, distributing TTS/STT requests across them
 * using a configurable load balancing strategy. Provides:
 *
 * - Automatic health checks on all workers
 * - Load-balanced request routing
 * - Automatic failover when a worker fails mid-request
 * - Circuit breaker integration per worker
 * - Pool status reporting for monitoring
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { BalancingStrategyName, LoadBalancerStrategy } from "./balancer.ts";
import { createBalancer } from "./balancer.ts";
import { STT_UPLOAD_TIMEOUT_MS, validateSttRequest, validateTtsRequest } from "./pool-validation.ts";
import type { SttResult } from "./stt-client.ts";
import type { TtsRequest, TtsResult } from "./tts-client.ts";
import type { GPUWorkerConfig, GPUWorkerInfo } from "./worker.ts";
import { GPUWorker } from "./worker.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the worker pool. */
export interface GPUWorkerPoolConfig {
  readonly workers: readonly GPUWorkerConfig[];
  readonly healthCheckIntervalMs: number;
  readonly loadBalancing: BalancingStrategyName;
  readonly maxRetries: number;
}

/** Summary of the entire pool's status. */
export interface GPUPoolStatus {
  readonly totalWorkers: number;
  readonly healthyWorkers: number;
  readonly degradedWorkers: number;
  readonly unhealthyWorkers: number;
  readonly totalActiveRequests: number;
  readonly workers: readonly GPUWorkerInfo[];
}

// ---------------------------------------------------------------------------
// GPUWorkerPool
// ---------------------------------------------------------------------------

export class GPUWorkerPool {
  private workers: GPUWorker[];
  private balancer: LoadBalancerStrategy;
  private maxRetries: number;
  private healthCheckIntervalMs: number;
  private readonly logger: Logger;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: GPUWorkerPoolConfig, logger: Logger) {
    this.logger = logger.child("gpu-pool");
    this.maxRetries = config.maxRetries;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs;
    this.balancer = createBalancer(config.loadBalancing);

    this.workers = config.workers.map((wc) => new GPUWorker(wc, logger));

    this.logger.info("init", `GPU worker pool created with ${this.workers.length} worker(s)`, {
      strategy: config.loadBalancing,
      healthCheckInterval: config.healthCheckIntervalMs,
    });
  }

  /**
   * Reconfigure the worker pool with new settings.
   * Replaces workers, balancer, and restarts health checks if they were running.
   */
  reconfigure(config: GPUWorkerPoolConfig): void {
    const wasChecking = this.healthCheckTimer !== null;

    // Stop current health checks before swapping workers
    this.stopHealthChecks();

    this.workers = config.workers.map((wc) => new GPUWorker(wc, this.logger));
    this.maxRetries = config.maxRetries;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs;
    this.balancer = createBalancer(config.loadBalancing);

    this.logger.info("reconfigure", `GPU worker pool reconfigured with ${this.workers.length} worker(s)`, {
      strategy: config.loadBalancing,
      healthCheckInterval: config.healthCheckIntervalMs,
    });

    // Restart health checks if they were running before
    if (wasChecking) {
      this.startHealthChecks();
    }
  }

  // -------------------------------------------------------------------------
  // Health monitoring
  // -------------------------------------------------------------------------

  /** Start periodic health checks for all workers. */
  startHealthChecks(): void {
    if (this.healthCheckTimer !== null) return;

    // Run an initial health check immediately
    void this.checkAllHealth();

    this.healthCheckTimer = setInterval(() => {
      void this.checkAllHealth();
    }, this.healthCheckIntervalMs);

    this.logger.info("health", "Health check monitoring started", {
      intervalMs: this.healthCheckIntervalMs,
    });
  }

  /** Stop periodic health checks. */
  stopHealthChecks(): void {
    if (this.healthCheckTimer !== null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      this.logger.info("health", "Health check monitoring stopped");
    }
  }

  /** Run a health check on all workers. */
  async checkAllHealth(): Promise<void> {
    const results = await Promise.allSettled(this.workers.map((w) => w.checkHealth()));

    let healthy = 0;
    let unhealthy = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok) {
        healthy++;
      } else {
        unhealthy++;
      }
    }

    this.logger.debug("health", `Health check complete: ${healthy} healthy, ${unhealthy} unhealthy`);
  }

  // -------------------------------------------------------------------------
  // Worker selection
  // -------------------------------------------------------------------------

  /** Select the best worker for a given capability using the configured strategy. */
  selectWorker(capability: string): GPUWorkerInfo | null {
    const workerInfos = this.workers.map((w) => w.getInfo());
    return this.balancer.select(workerInfos, capability);
  }

  // -------------------------------------------------------------------------
  // TTS
  // -------------------------------------------------------------------------

  /** Synthesize text to speech, with automatic failover across workers. */
  async tts(request: TtsRequest): Promise<Result<TtsResult, EidolonError>> {
    const validationError = validateTtsRequest(request);
    if (validationError !== null) {
      return Err(validationError);
    }

    const body = JSON.stringify({
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      format: request.format ?? "opus",
    });

    const triedWorkers = new Set<string>();
    let lastError: EidolonError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const workerInfos = this.workers.map((w) => w.getInfo());
      // Exclude already-tried workers from selection
      const available = workerInfos.filter((w) => !triedWorkers.has(w.name));
      const selected = this.balancer.select(available, "tts");

      if (selected === null) {
        break;
      }

      const worker = this.workers.find((w) => w.name === selected.name);
      if (!worker) break;

      triedWorkers.add(selected.name);

      const startMs = Date.now();
      const result = await worker.executeRequest<ArrayBuffer>("/tts/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (result.ok) {
        const audio = new Uint8Array(result.value);
        const durationMs = Date.now() - startMs;

        this.logger.debug("tts", "TTS completed", {
          worker: selected.name,
          textLength: request.text.length,
          audioBytes: audio.byteLength,
          durationMs,
          attempt,
        });

        return Ok({ audio, format: request.format ?? "opus", durationMs });
      }

      lastError = result.error;
      this.logger.warn("tts", `TTS failed on worker '${selected.name}', attempting failover`, {
        error: result.error.message,
        attempt,
        retriesLeft: this.maxRetries - attempt,
      });
    }

    return Err(lastError ?? createError(ErrorCode.GPU_UNAVAILABLE, "No GPU workers available for TTS"));
  }

  // -------------------------------------------------------------------------
  // STT
  // -------------------------------------------------------------------------

  /** Transcribe audio to text, with automatic failover across workers. */
  async stt(audio: Uint8Array, mimeType?: string): Promise<Result<SttResult, EidolonError>> {
    const validationError = validateSttRequest(audio, mimeType);
    if (validationError !== null) {
      return Err(validationError);
    }

    const mime = mimeType ?? "audio/wav";
    const extension = mime.split("/")[1] ?? "wav";
    const formData = new FormData();
    const blob = new Blob([audio], { type: mime });
    formData.append("file", blob, `audio.${extension}`);

    const triedWorkers = new Set<string>();
    let lastError: EidolonError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const workerInfos = this.workers.map((w) => w.getInfo());
      const available = workerInfos.filter((w) => !triedWorkers.has(w.name));
      const selected = this.balancer.select(available, "stt");

      if (selected === null) {
        break;
      }

      const worker = this.workers.find((w) => w.name === selected.name);
      if (!worker) break;

      triedWorkers.add(selected.name);

      const result = await worker.executeRequest<SttResult>(
        "/stt/transcribe",
        { method: "POST", body: formData },
        STT_UPLOAD_TIMEOUT_MS,
      );

      if (result.ok) {
        this.logger.debug("stt", "STT completed", {
          worker: selected.name,
          textLength: result.value.text.length,
          language: result.value.language,
          attempt,
        });
        return Ok(result.value);
      }

      lastError = result.error;
      this.logger.warn("stt", `STT failed on worker '${selected.name}', attempting failover`, {
        error: result.error.message,
        attempt,
        retriesLeft: this.maxRetries - attempt,
      });
    }

    return Err(lastError ?? createError(ErrorCode.GPU_UNAVAILABLE, "No GPU workers available for STT"));
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** Get the current status of the entire pool. */
  getPoolStatus(): GPUPoolStatus {
    const infos = this.workers.map((w) => w.getInfo());

    let healthy = 0;
    let degraded = 0;
    let unhealthy = 0;
    let totalActive = 0;

    for (const info of infos) {
      totalActive += info.activeRequests;
      if (info.circuitState === "closed" && info.health !== null) {
        healthy++;
      } else if (info.circuitState === "half_open") {
        degraded++;
      } else {
        unhealthy++;
      }
    }

    return {
      totalWorkers: infos.length,
      healthyWorkers: healthy,
      degradedWorkers: degraded,
      unhealthyWorkers: unhealthy,
      totalActiveRequests: totalActive,
      workers: infos,
    };
  }

  /** Check whether any worker supports the given capability. */
  hasCapability(capability: string): boolean {
    return this.workers.some((w) => {
      const info = w.getInfo();
      return (
        info.capabilities.includes(capability as "tts" | "stt" | "realtime") &&
        (info.circuitState === "closed" || info.circuitState === "half_open")
      );
    });
  }

  /** Get the number of workers in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /** Clean up resources. */
  dispose(): void {
    this.stopHealthChecks();
    this.logger.info("dispose", "GPU worker pool disposed");
  }
}
