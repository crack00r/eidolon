/**
 * BaseCrawler -- abstract class for all source crawlers.
 *
 * Provides rate limiting, error handling, and content sanitization.
 * Subclasses implement the `crawlSource()` method for each source type.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { SourceType } from "../discovery.ts";
import { sanitizeContent } from "./sanitize.ts";

/** Raw item discovered from a source before storage. */
export interface CrawledItem {
  readonly sourceType: SourceType;
  readonly url: string;
  readonly title: string;
  readonly content: string;
}

/** Configuration passed to each crawler from the learning config. */
export interface CrawlerSourceConfig {
  readonly type: SourceType;
  readonly config: Record<string, string | number | boolean>;
}

/** Options controlling how a crawl is executed. */
export interface CrawlOptions {
  /** Maximum number of items to return from a single crawl. */
  readonly maxItems?: number;
  /** Minimum score threshold (source-specific, e.g. Reddit upvotes). */
  readonly minScore?: number;
}

/**
 * Abstract base for all crawlers. Handles rate limiting, sanitization,
 * and wrapping fetch errors into the Result pattern.
 */
export abstract class BaseCrawler {
  protected readonly logger: Logger;
  private lastRequestAt = 0;
  private readonly minIntervalMs: number;

  /**
   * @param logger Logger instance
   * @param minIntervalMs Minimum milliseconds between HTTP requests (rate limiting)
   */
  constructor(logger: Logger, minIntervalMs = 2000) {
    this.logger = logger;
    this.minIntervalMs = minIntervalMs;
  }

  /** The source type this crawler handles. */
  abstract readonly sourceType: SourceType;

  /** Subclass-specific crawling logic. */
  protected abstract crawlSource(
    config: CrawlerSourceConfig,
    options: CrawlOptions,
  ): Promise<CrawledItem[]>;

  /**
   * Execute a crawl with rate limiting, sanitization, and error handling.
   */
  async crawl(
    config: CrawlerSourceConfig,
    options: CrawlOptions = {},
  ): Promise<Result<CrawledItem[], EidolonError>> {
    try {
      const items = await this.crawlSource(config, options);

      // Sanitize all content
      const sanitized = items.map((item) => ({
        ...item,
        content: sanitizeContent(item.content),
        title: item.title.slice(0, 1000),
      }));

      this.logger.info("crawl", `Crawled ${sanitized.length} items from ${config.type}`, {
        source: config.type,
        count: sanitized.length,
      });

      return Ok(sanitized);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error("crawl", `Crawl failed for ${config.type}: ${message}`, cause);
      return Err(
        createError(ErrorCode.DISCOVERY_FAILED, `Crawl failed for ${config.type}: ${message}`, cause),
      );
    }
  }

  /**
   * Rate-limited fetch wrapper. Waits if called too quickly.
   */
  protected async rateLimitedFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();

    const headers: Record<string, string> = {
      "User-Agent": "Eidolon/1.0 (Self-Learning Crawler; +https://github.com/crack00r/eidolon)",
      ...(init?.headers as Record<string, string> | undefined),
    };

    const response = await fetch(url, { ...init, headers });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    return response;
  }
}
