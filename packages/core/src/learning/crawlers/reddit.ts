/**
 * RedditCrawler -- fetches posts from Reddit's public JSON API.
 *
 * Uses `https://www.reddit.com/r/{subreddit}/hot.json` which requires no
 * authentication for public subreddits. Rate limited to 1 request per 2 seconds
 * per Reddit API guidelines.
 */

import { z } from "zod";
import type { Logger } from "../../logging/logger.ts";
import type { SourceType } from "../discovery.ts";
import { BaseCrawler, type CrawledItem, type CrawlerSourceConfig, type CrawlOptions } from "./base.ts";

/** Zod schema for validating Reddit API response shape. */
const RedditListingSchema = z.object({
  data: z.object({
    children: z.array(
      z.object({
        data: z.object({
          title: z.string(),
          selftext: z.string().default(""),
          url: z.string(),
          permalink: z.string(),
          score: z.number(),
          num_comments: z.number(),
          created_utc: z.number(),
          is_self: z.boolean(),
          subreddit: z.string(),
        }),
      }),
    ),
  }),
});

/** Default limit per subreddit request. */
const DEFAULT_LIMIT = 25;

/** Default minimum score filter. */
const DEFAULT_MIN_SCORE = 10;

export class RedditCrawler extends BaseCrawler {
  readonly sourceType: SourceType = "reddit";

  constructor(logger: Logger) {
    // Reddit asks for max 1 request per 2 seconds
    super(logger.child("crawler:reddit"), 2000);
  }

  protected async crawlSource(config: CrawlerSourceConfig, options: CrawlOptions): Promise<CrawledItem[]> {
    const subredditsRaw = String(config.config.subreddits ?? "");
    if (!subredditsRaw) {
      this.logger.warn("crawlSource", "No subreddits configured, skipping Reddit crawl");
      return [];
    }

    const subreddits = subredditsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = options.maxItems ?? DEFAULT_LIMIT;
    const minScore = options.minScore ?? Number(config.config.minScore ?? DEFAULT_MIN_SCORE);
    const sortBy = String(config.config.sortBy ?? "hot");

    const items: CrawledItem[] = [];

    for (const subreddit of subreddits) {
      const subItems = await this.crawlSubreddit(subreddit, sortBy, limit, minScore);
      items.push(...subItems);
    }

    return items;
  }

  private async crawlSubreddit(
    subreddit: string,
    sortBy: string,
    limit: number,
    minScore: number,
  ): Promise<CrawledItem[]> {
    const safeSort = ["hot", "new", "top", "rising"].includes(sortBy) ? sortBy : "hot";
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${safeSort}.json?limit=${limit}&raw_json=1`;

    const response = await this.rateLimitedFetch(url);
    const json: unknown = await response.json();
    const parsed = RedditListingSchema.safeParse(json);

    if (!parsed.success) {
      this.logger.warn("crawlSubreddit", `Failed to parse Reddit response for r/${subreddit}`, {
        error: parsed.error.message,
      });
      return [];
    }

    const items: CrawledItem[] = [];

    for (const child of parsed.data.data.children) {
      const post = child.data;

      if (post.score < minScore) {
        continue;
      }

      const postUrl = post.is_self ? `https://www.reddit.com${post.permalink}` : post.url;

      const content = buildRedditContent(post);

      items.push({
        sourceType: "reddit",
        url: postUrl,
        title: post.title,
        content,
      });
    }

    this.logger.debug("crawlSubreddit", `r/${subreddit}: ${items.length} posts above score ${minScore}`);
    return items;
  }
}

function buildRedditContent(post: {
  title: string;
  selftext: string;
  score: number;
  num_comments: number;
  subreddit: string;
}): string {
  const parts: string[] = [`Subreddit: r/${post.subreddit}`, `Score: ${post.score} | Comments: ${post.num_comments}`];

  if (post.selftext) {
    // Truncate very long self-posts
    const text = post.selftext.length > 5000 ? `${post.selftext.slice(0, 5000)}...` : post.selftext;
    parts.push("", text);
  }

  return parts.join("\n");
}
