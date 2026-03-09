/**
 * HackerNewsCrawler -- fetches top stories from the HN Firebase API.
 *
 * Uses the official Hacker News API:
 * - Top stories: https://hacker-news.firebaseio.com/v0/topstories.json
 * - Item details: https://hacker-news.firebaseio.com/v0/item/{id}.json
 */

import { z } from "zod";
import type { Logger } from "../../logging/logger.ts";
import type { SourceType } from "../discovery.ts";
import { BaseCrawler, type CrawledItem, type CrawlerSourceConfig, type CrawlOptions } from "./base.ts";

/** Zod schema for a single HN item. */
const HNItemSchema = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  score: z.number().optional(),
  by: z.string().optional(),
  time: z.number().optional(),
  descendants: z.number().optional(),
});

/** Default number of stories to check. */
const DEFAULT_LIMIT = 30;

/** Default minimum score. */
const DEFAULT_MIN_SCORE = 50;

export class HackerNewsCrawler extends BaseCrawler {
  readonly sourceType: SourceType = "hackernews";

  constructor(logger: Logger) {
    // HN API is generous, 500ms between requests is safe
    super(logger.child("crawler:hackernews"), 500);
  }

  protected async crawlSource(config: CrawlerSourceConfig, options: CrawlOptions): Promise<CrawledItem[]> {
    const limit = options.maxItems ?? Math.max(1, Number(config.config.limit) || DEFAULT_LIMIT);
    const minScore = options.minScore ?? Number(config.config.minScore ?? DEFAULT_MIN_SCORE);

    // Fetch top story IDs
    const topStoriesUrl = "https://hacker-news.firebaseio.com/v0/topstories.json";
    const response = await this.rateLimitedFetch(topStoriesUrl);
    const storyIds: unknown = await response.json();

    if (!Array.isArray(storyIds)) {
      this.logger.warn("crawlSource", "Unexpected HN top stories response");
      return [];
    }

    // Take only the top N story IDs
    const idsToFetch = storyIds.filter((id): id is number => typeof id === "number").slice(0, limit);
    const items: CrawledItem[] = [];

    for (const storyId of idsToFetch) {
      const item = await this.fetchStory(storyId, minScore);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  private async fetchStory(storyId: number, minScore: number): Promise<CrawledItem | null> {
    const url = `https://hacker-news.firebaseio.com/v0/item/${storyId}.json`;

    try {
      const response = await this.rateLimitedFetch(url);
      const json: unknown = await response.json();
      const parsed = HNItemSchema.safeParse(json);

      if (!parsed.success) {
        return null;
      }

      const story = parsed.data;

      // Filter by score and type
      if (story.type !== "story" || !story.title) {
        return null;
      }

      if ((story.score ?? 0) < minScore) {
        return null;
      }

      const storyUrl = story.url ?? `https://news.ycombinator.com/item?id=${story.id}`;
      const content = buildHNContent(story);

      return {
        sourceType: "hackernews",
        url: storyUrl,
        title: story.title,
        content,
      };
    } catch (error) {
      this.logger.debug("fetchStory", `Failed to fetch HN story ${storyId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function buildHNContent(story: z.infer<typeof HNItemSchema>): string {
  const parts: string[] = [
    `HN Score: ${story.score ?? 0} | Comments: ${story.descendants ?? 0}`,
    `Posted by: ${story.by ?? "unknown"}`,
  ];

  if (story.url) {
    parts.push(`Link: ${story.url}`);
  }

  if (story.text) {
    // HN story text is HTML, strip basic tags
    const cleaned = story.text
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'");

    const truncated = cleaned.length > 3000 ? `${cleaned.slice(0, 3000)}...` : cleaned;
    parts.push("", truncated);
  }

  return parts.join("\n");
}
