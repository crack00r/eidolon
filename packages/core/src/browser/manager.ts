/**
 * BrowserManager -- lifecycle management for browser automation.
 *
 * Manages browser start/stop, tab limits, and screenshot caching.
 * Wraps an IBrowserClient with additional operational concerns.
 */

import type { BrowserConfig, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { IBrowserClient, PageSnapshot, ScreenshotResult } from "./browser-client.ts";

/** Cached screenshot entry with timestamp for expiration. */
interface CachedScreenshot {
  readonly result: ScreenshotResult;
  readonly capturedAt: number;
}

/** Default cache TTL: 30 seconds. */
const SCREENSHOT_CACHE_TTL_MS = 30_000;

/** Maximum screenshot cache size. */
const MAX_CACHE_ENTRIES = 20;

export class BrowserManager {
  private readonly client: IBrowserClient;
  private readonly config: BrowserConfig;
  private readonly logger: Logger;
  private readonly screenshotCache = new Map<string, CachedScreenshot>();
  private started = false;

  constructor(client: IBrowserClient, config: BrowserConfig, logger: Logger) {
    this.client = client;
    this.config = config;
    this.logger = logger.child("browser:manager");
  }

  /** Whether the browser module is enabled in config. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Whether the browser is currently running and connected. */
  isRunning(): boolean {
    return this.started && this.client.isConnected();
  }

  /** Get the underlying browser client. */
  getClient(): IBrowserClient {
    return this.client;
  }

  /**
   * Start the browser manager. Validates config and marks as started.
   * The actual browser launch is lazy (on first navigate/action).
   */
  start(): Result<void, EidolonError> {
    if (!this.config.enabled) {
      return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, "Browser automation is not enabled in configuration"));
    }

    if (this.started) {
      this.logger.warn("browser", "Browser manager already started");
      return Ok(undefined);
    }

    this.started = true;
    this.logger.info("browser", "Browser manager started", {
      headless: this.config.headless,
      maxTabs: this.config.maxTabs,
    });
    return Ok(undefined);
  }

  /**
   * Navigate to a URL. Returns a page snapshot.
   */
  async navigate(url: string): Promise<Result<PageSnapshot, EidolonError>> {
    const guard = this.guardRunning();
    if (!guard.ok) return guard;

    return this.client.navigate(url);
  }

  /**
   * Get a snapshot of the current page.
   */
  async snapshot(): Promise<Result<PageSnapshot, EidolonError>> {
    const guard = this.guardRunning();
    if (!guard.ok) return guard;

    return this.client.snapshot();
  }

  /**
   * Click an element on the current page.
   */
  async click(selector: string): Promise<Result<void, EidolonError>> {
    const guard = this.guardRunning();
    if (!guard.ok) return guard;

    return this.client.click(selector);
  }

  /**
   * Fill an input field on the current page.
   */
  async fill(selector: string, value: string): Promise<Result<void, EidolonError>> {
    const guard = this.guardRunning();
    if (!guard.ok) return guard;

    return this.client.fill(selector, value);
  }

  /**
   * Take a screenshot. Caches recent screenshots by URL to reduce overhead.
   */
  async screenshot(skipCache = false): Promise<Result<ScreenshotResult, EidolonError>> {
    const guard = this.guardRunning();
    if (!guard.ok) return guard;

    // Check cache first
    if (!skipCache) {
      const snapResult = await this.client.snapshot();
      if (snapResult.ok) {
        const cached = this.getFromCache(snapResult.value.url);
        if (cached) {
          this.logger.debug("browser", "Screenshot served from cache", { url: snapResult.value.url });
          return Ok(cached);
        }
      }
    }

    const result = await this.client.screenshot();
    if (result.ok) {
      this.addToCache(result.value.url, result.value);
    }
    return result;
  }

  /**
   * Evaluate JavaScript in the browser context.
   */
  async evaluate(script: string): Promise<Result<unknown, EidolonError>> {
    const guard = this.guardRunning();
    if (!guard.ok) return guard;

    const result = await this.client.evaluate(script);
    if (!result.ok) return result;
    return Ok(result.value.value);
  }

  /**
   * Stop the browser and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    this.screenshotCache.clear();
    await this.client.close();
    this.started = false;
    this.logger.info("browser", "Browser manager stopped");
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private guardRunning(): Result<void, EidolonError> {
    if (!this.started) {
      return Err(createError(ErrorCode.BROWSER_NOT_STARTED, "Browser manager is not started"));
    }
    return Ok(undefined);
  }

  private getFromCache(url: string): ScreenshotResult | null {
    const entry = this.screenshotCache.get(url);
    if (!entry) return null;

    if (Date.now() - entry.capturedAt > SCREENSHOT_CACHE_TTL_MS) {
      this.screenshotCache.delete(url);
      return null;
    }

    return entry.result;
  }

  private addToCache(url: string, result: ScreenshotResult): void {
    // Evict oldest entries if cache is full
    if (this.screenshotCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.findOldestCacheKey();
      if (oldest) this.screenshotCache.delete(oldest);
    }

    this.screenshotCache.set(url, { result, capturedAt: Date.now() });
  }

  private findOldestCacheKey(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.screenshotCache) {
      if (entry.capturedAt < oldestTime) {
        oldestTime = entry.capturedAt;
        oldestKey = key;
      }
    }

    return oldestKey;
  }
}
