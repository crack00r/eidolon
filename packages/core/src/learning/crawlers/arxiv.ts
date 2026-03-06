/**
 * ArxivCrawler -- searches arXiv papers via the public API.
 *
 * Uses `http://export.arxiv.org/api/query` which returns Atom XML.
 * Rate limit: arXiv asks for max 1 request per 3 seconds.
 */

import type { SourceType } from "../discovery.ts";
import { BaseCrawler, type CrawledItem, type CrawlerSourceConfig, type CrawlOptions } from "./base.ts";
import type { Logger } from "../../logging/logger.ts";

/** Default number of results. */
const DEFAULT_LIMIT = 15;

export class ArxivCrawler extends BaseCrawler {
  readonly sourceType: SourceType = "arxiv";

  constructor(logger: Logger) {
    // arXiv asks for max 1 request per 3 seconds
    super(logger.child("crawler:arxiv"), 3000);
  }

  protected async crawlSource(
    config: CrawlerSourceConfig,
    options: CrawlOptions,
  ): Promise<CrawledItem[]> {
    const query = String(config.config["query"] ?? "");
    const categories = String(config.config["categories"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const limit = options.maxItems ?? Number(config.config["limit"] ?? DEFAULT_LIMIT);

    if (!query && categories.length === 0) {
      this.logger.warn("crawlSource", "No query or categories configured, skipping arXiv crawl");
      return [];
    }

    // Build arXiv search query
    const searchParts: string[] = [];

    if (query) {
      searchParts.push(`all:${query}`);
    }

    if (categories.length > 0) {
      const catQuery = categories.map((c) => `cat:${c}`).join("+OR+");
      searchParts.push(catQuery);
    }

    const searchQuery = searchParts.join("+AND+");
    const url = `https://export.arxiv.org/api/query?search_query=${searchQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;

    const response = await this.rateLimitedFetch(url);
    const xml = await response.text();

    return parseArxivResponse(xml);
  }
}

/** Parse arXiv Atom XML response into crawled items. */
function parseArxivResponse(xml: string): CrawledItem[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/gi);
  if (!entries) return [];

  const items: CrawledItem[] = [];

  for (const entry of entries) {
    const titleRaw = extractTag(entry, "title");
    const title = titleRaw?.replace(/\s+/g, " ").trim() ?? null;
    const summaryRaw = extractTag(entry, "summary");
    const summary = summaryRaw?.replace(/\s+/g, " ").trim() ?? null;
    const link = extractArxivLink(entry);
    const authors = extractAuthors(entry);
    const published = extractTag(entry, "published");
    const categories = extractCategories(entry);

    if (!title || !link) continue;

    const content = buildArxivContent({ summary, authors, published, categories });

    items.push({
      sourceType: "arxiv",
      url: link,
      title,
      content,
    });
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function extractArxivLink(entry: string): string | null {
  // arXiv entries have multiple links; we want the one with title="pdf" or the abstract page
  const absMatch = entry.match(/<link[^>]+href="(https:\/\/arxiv\.org\/abs\/[^"]+)"[^>]*\/?>/i);
  if (absMatch?.[1]) return absMatch[1];

  // Fallback to any link
  const linkMatch = entry.match(/<link[^>]+href="([^"]+)"[^>]*\/?>/i);
  return linkMatch?.[1] ?? null;
}

function extractAuthors(entry: string): string[] {
  const authorMatches = entry.match(/<author>\s*<name>([^<]+)<\/name>\s*<\/author>/gi);
  if (!authorMatches) return [];

  return authorMatches.map((m) => {
    const nameMatch = m.match(/<name>([^<]+)<\/name>/i);
    return nameMatch?.[1]?.trim() ?? "";
  }).filter(Boolean);
}

function extractCategories(entry: string): string[] {
  const catMatches = entry.match(/term="([^"]+)"/gi);
  if (!catMatches) return [];

  return catMatches.map((m) => {
    const termMatch = m.match(/term="([^"]+)"/i);
    return termMatch?.[1] ?? "";
  }).filter(Boolean);
}

function buildArxivContent(opts: {
  summary: string | null;
  authors: string[];
  published: string | null;
  categories: string[];
}): string {
  const parts: string[] = [];

  if (opts.authors.length > 0) {
    const authorList = opts.authors.length > 5
      ? opts.authors.slice(0, 5).join(", ") + ` et al. (${opts.authors.length} authors)`
      : opts.authors.join(", ");
    parts.push(`Authors: ${authorList}`);
  }

  if (opts.categories.length > 0) {
    parts.push(`Categories: ${opts.categories.join(", ")}`);
  }

  if (opts.published) {
    parts.push(`Published: ${opts.published}`);
  }

  if (opts.summary) {
    const truncated = opts.summary.length > 3000
      ? opts.summary.slice(0, 3000) + "..."
      : opts.summary;
    parts.push("", truncated);
  }

  return parts.join("\n");
}
