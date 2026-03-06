/**
 * RssCrawler -- parses RSS/Atom feeds.
 *
 * Uses standard XML parsing to extract items from RSS 2.0 and Atom feeds.
 * No external library needed -- we parse the XML with a simple regex-based
 * approach since we only need title, link, description, and pubDate.
 */

import type { Logger } from "../../logging/logger.ts";
import type { SourceType } from "../discovery.ts";
import { BaseCrawler, type CrawledItem, type CrawlerSourceConfig, type CrawlOptions } from "./base.ts";

/** Default maximum items per feed. */
const DEFAULT_LIMIT = 20;

/** Maximum age of feed items to consider (7 days). */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class RssCrawler extends BaseCrawler {
  readonly sourceType: SourceType = "rss";

  constructor(logger: Logger) {
    super(logger.child("crawler:rss"), 1000);
  }

  protected async crawlSource(config: CrawlerSourceConfig, options: CrawlOptions): Promise<CrawledItem[]> {
    const feedsRaw = String(config.config.feeds ?? "");
    if (!feedsRaw) {
      this.logger.warn("crawlSource", "No feeds configured, skipping RSS crawl");
      return [];
    }

    const feeds = feedsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = options.maxItems ?? Number(config.config.limit ?? DEFAULT_LIMIT);
    const maxAgeMs = Number(config.config.maxAgeDays ?? 7) * 24 * 60 * 60 * 1000 || DEFAULT_MAX_AGE_MS;

    const items: CrawledItem[] = [];

    for (const feedUrl of feeds) {
      const feedItems = await this.crawlFeed(feedUrl, limit, maxAgeMs);
      items.push(...feedItems);
    }

    return items;
  }

  private async crawlFeed(feedUrl: string, limit: number, maxAgeMs: number): Promise<CrawledItem[]> {
    try {
      const response = await this.rateLimitedFetch(feedUrl);
      const xml = await response.text();
      const entries = parseFeed(xml);
      const now = Date.now();

      const items: CrawledItem[] = [];

      for (const entry of entries) {
        if (items.length >= limit) break;

        // Filter by age
        if (entry.pubDate) {
          const entryTime = new Date(entry.pubDate).getTime();
          if (Number.isFinite(entryTime) && now - entryTime > maxAgeMs) {
            continue;
          }
        }

        if (!entry.link || !entry.title) continue;

        items.push({
          sourceType: "rss",
          url: entry.link,
          title: entry.title,
          content: buildRssContent(entry),
        });
      }

      this.logger.debug("crawlFeed", `Feed ${feedUrl}: ${items.length} items`, {
        feedUrl,
        count: items.length,
      });

      return items;
    } catch (error) {
      this.logger.warn("crawlFeed", `Failed to crawl feed: ${feedUrl}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

interface FeedEntry {
  title: string | null;
  link: string | null;
  description: string | null;
  pubDate: string | null;
}

/**
 * Parse RSS 2.0 or Atom feed XML into entries.
 * Uses simple regex extraction -- no XML parser dependency needed.
 */
function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];

  // Try RSS 2.0 format first (<item> elements)
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi);
  if (rssItems && rssItems.length > 0) {
    for (const item of rssItems) {
      entries.push({
        title: extractTag(item, "title"),
        link: extractTag(item, "link"),
        description: extractTag(item, "description"),
        pubDate: extractTag(item, "pubDate"),
      });
    }
    return entries;
  }

  // Try Atom format (<entry> elements)
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi);
  if (atomEntries && atomEntries.length > 0) {
    for (const entry of atomEntries) {
      entries.push({
        title: extractTag(entry, "title"),
        link: extractAtomLink(entry),
        description: extractTag(entry, "summary") ?? extractTag(entry, "content"),
        pubDate: extractTag(entry, "published") ?? extractTag(entry, "updated"),
      });
    }
  }

  return entries;
}

/** Extract text content from an XML tag. */
function extractTag(xml: string, tag: string): string | null {
  // Handle CDATA sections
  const cdataPattern = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch?.[1] !== undefined) {
    return stripHtml(cdataMatch[1]).trim();
  }

  // Handle regular content
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(pattern);
  if (match?.[1] !== undefined) {
    return stripHtml(match[1]).trim();
  }

  return null;
}

/** Extract href from Atom <link> element. */
function extractAtomLink(xml: string): string | null {
  const match = xml.match(/<link[^>]+href="([^"]+)"[^>]*\/?>/i);
  return match?.[1] ?? null;
}

/** Strip HTML tags from content. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function buildRssContent(entry: FeedEntry): string {
  const parts: string[] = [];

  if (entry.description) {
    const desc = entry.description.length > 3000 ? `${entry.description.slice(0, 3000)}...` : entry.description;
    parts.push(desc);
  }

  if (entry.pubDate) {
    parts.push(`Published: ${entry.pubDate}`);
  }

  return parts.join("\n");
}
