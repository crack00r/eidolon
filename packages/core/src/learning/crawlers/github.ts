/**
 * GitHubCrawler -- searches GitHub repositories via the public REST API.
 *
 * Uses `https://api.github.com/search/repositories` which does not require
 * authentication for public data (rate limited to 10 requests/minute unauthenticated).
 */

import { z } from "zod";
import type { SourceType } from "../discovery.ts";
import { BaseCrawler, type CrawledItem, type CrawlerSourceConfig, type CrawlOptions } from "./base.ts";
import type { Logger } from "../../logging/logger.ts";

/** Zod schema for GitHub search API response. */
const GitHubSearchSchema = z.object({
  total_count: z.number(),
  items: z.array(
    z.object({
      full_name: z.string(),
      html_url: z.string(),
      description: z.string().nullable(),
      stargazers_count: z.number(),
      language: z.string().nullable(),
      topics: z.array(z.string()).default([]),
      created_at: z.string(),
      updated_at: z.string(),
      pushed_at: z.string(),
    }),
  ),
});

/** Default minimum stars. */
const DEFAULT_MIN_STARS = 10;

/** Default number of results. */
const DEFAULT_LIMIT = 25;

export class GitHubCrawler extends BaseCrawler {
  readonly sourceType: SourceType = "github";

  constructor(logger: Logger) {
    // GitHub unauthenticated: 10 requests/min, so ~6 seconds between requests
    super(logger.child("crawler:github"), 6000);
  }

  protected async crawlSource(
    config: CrawlerSourceConfig,
    options: CrawlOptions,
  ): Promise<CrawledItem[]> {
    const topics = String(config.config["topics"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const languages = String(config.config["languages"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const minStars = options.minScore ?? Number(config.config["minStars"] ?? DEFAULT_MIN_STARS);
    const limit = options.maxItems ?? Number(config.config["limit"] ?? DEFAULT_LIMIT);

    // Build search query
    const queryParts: string[] = [];

    if (topics.length > 0) {
      for (const topic of topics) {
        queryParts.push(`topic:${topic}`);
      }
    }

    if (languages.length > 0) {
      for (const lang of languages) {
        queryParts.push(`language:${lang}`);
      }
    }

    queryParts.push(`stars:>=${minStars}`);

    // Only get repos pushed to in the last 7 days for freshness
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    queryParts.push(`pushed:>=${weekAgo.toISOString().slice(0, 10)}`);

    const query = queryParts.join(" ");
    const encodedQuery = encodeURIComponent(query);
    const url = `https://api.github.com/search/repositories?q=${encodedQuery}&sort=stars&order=desc&per_page=${limit}`;

    const response = await this.rateLimitedFetch(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    const json: unknown = await response.json();
    const parsed = GitHubSearchSchema.safeParse(json);

    if (!parsed.success) {
      this.logger.warn("crawlSource", "Failed to parse GitHub search response", {
        error: parsed.error.message,
      });
      return [];
    }

    const items: CrawledItem[] = [];

    for (const repo of parsed.data.items) {
      const content = buildGitHubContent(repo);

      items.push({
        sourceType: "github",
        url: repo.html_url,
        title: repo.full_name,
        content,
      });
    }

    return items;
  }
}

function buildGitHubContent(repo: {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  topics: string[];
  pushed_at: string;
}): string {
  const parts: string[] = [];

  if (repo.description) {
    parts.push(repo.description);
  }

  parts.push(`Stars: ${repo.stargazers_count}`);

  if (repo.language) {
    parts.push(`Language: ${repo.language}`);
  }

  if (repo.topics.length > 0) {
    parts.push(`Topics: ${repo.topics.join(", ")}`);
  }

  parts.push(`Last pushed: ${repo.pushed_at}`);

  return parts.join("\n");
}
