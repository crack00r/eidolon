/**
 * CrawlerRegistry -- maps source types to their crawler implementations.
 *
 * Provides a single entry point for the DiscoveryEngine to crawl any
 * configured source type.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { SourceType } from "../discovery.ts";
import { ArxivCrawler } from "./arxiv.ts";
import type { BaseCrawler, CrawledItem, CrawlerSourceConfig, CrawlOptions } from "./base.ts";
import { GitHubCrawler } from "./github.ts";
import { HackerNewsCrawler } from "./hackernews.ts";
import { RedditCrawler } from "./reddit.ts";
import { RssCrawler } from "./rss.ts";

export { ArxivCrawler } from "./arxiv.ts";
export type { CrawledItem, CrawlerSourceConfig, CrawlOptions } from "./base.ts";
export { BaseCrawler } from "./base.ts";
export { GitHubCrawler } from "./github.ts";
export { HackerNewsCrawler } from "./hackernews.ts";
export { RedditCrawler } from "./reddit.ts";
export { RssCrawler } from "./rss.ts";
export { sanitizeContent } from "./sanitize.ts";

/**
 * Registry that instantiates and manages crawlers for all supported source types.
 */
export class CrawlerRegistry {
  private readonly crawlers: ReadonlyMap<SourceType, BaseCrawler>;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child("crawlers");

    const crawlerMap = new Map<SourceType, BaseCrawler>();
    crawlerMap.set("reddit", new RedditCrawler(this.logger));
    crawlerMap.set("hackernews", new HackerNewsCrawler(this.logger));
    crawlerMap.set("github", new GitHubCrawler(this.logger));
    crawlerMap.set("rss", new RssCrawler(this.logger));
    crawlerMap.set("arxiv", new ArxivCrawler(this.logger));

    this.crawlers = crawlerMap;
  }

  /**
   * Crawl a single configured source.
   */
  async crawlSource(
    config: CrawlerSourceConfig,
    options: CrawlOptions = {},
  ): Promise<Result<CrawledItem[], EidolonError>> {
    const crawler = this.crawlers.get(config.type);
    if (!crawler) {
      return Err(createError(ErrorCode.DISCOVERY_FAILED, `Unknown source type: ${config.type}`));
    }

    return crawler.crawl(config, options);
  }

  /**
   * Crawl all configured sources and return combined results.
   */
  async crawlAll(
    sources: readonly CrawlerSourceConfig[],
    options: CrawlOptions = {},
  ): Promise<Result<CrawledItem[], EidolonError>> {
    const allItems: CrawledItem[] = [];

    for (const source of sources) {
      const result = await this.crawlSource(source, options);
      if (result.ok) {
        allItems.push(...result.value);
      } else {
        // Log error but continue with other sources
        this.logger.warn("crawlAll", `Source ${source.type} failed, continuing`, {
          error: result.error.message,
        });
      }
    }

    this.logger.info("crawlAll", `Crawled ${allItems.length} items from ${sources.length} sources`);
    return { ok: true, value: allItems };
  }

  /** Get the crawler for a specific source type. */
  getCrawler(type: SourceType): BaseCrawler | undefined {
    return this.crawlers.get(type);
  }

  /** Get all supported source types. */
  getSupportedTypes(): SourceType[] {
    return [...this.crawlers.keys()];
  }
}
