/**
 * Types, constants, and helper functions for the ResearchEngine.
 *
 * Extracted from engine.ts to keep modules under ~300 lines.
 */

import type { StreamEvent } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResearchSource = "web" | "academic" | "github" | "hackernews" | "reddit";

export interface ResearchRequest {
  readonly query: string;
  readonly sources: readonly ResearchSource[];
  readonly maxSources: number;
  readonly deliverTo?: string;
}

export interface Citation {
  readonly url: string;
  readonly title: string;
  readonly source: ResearchSource;
  readonly relevance: number;
  readonly snippet: string;
}

export interface ResearchFinding {
  readonly title: string;
  readonly summary: string;
  readonly citations: readonly Citation[];
  readonly confidence: number;
}

export interface ResearchResult {
  readonly id: string;
  readonly query: string;
  readonly findings: readonly ResearchFinding[];
  readonly summary: string;
  readonly citations: readonly Citation[];
  readonly tokensUsed: number;
  readonly durationMs: number;
  readonly completedAt: number;
}

export interface ResearchEngineConfig {
  readonly workspaceDir: string;
  readonly maxSources: number;
  /** Optional model override for the research session. */
  readonly model?: string;
  /** Optional timeout for the research session in milliseconds. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SOURCES = new Set<string>(["web", "academic", "github", "hackernews", "reddit"]);

export const DEFAULT_MAX_SOURCES = 10;
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const MAX_QUERY_LENGTH = 4096;

/**
 * Regex patterns for extracting citations from text.
 * Supports formats:
 *  - Markdown links: [title](url)
 *  - Numbered refs: [1] url or [1]: url
 *  - Parenthetical: (Source: url)
 *  - Bare URLs: https://...
 */
export const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
export const NUMBERED_REF_PATTERN = /\[(\d+)\]:?\s+(https?:\/\/[^\s]+)/g;
export const PARENTHETICAL_PATTERN = /\((?:Source|Ref|Reference|Citation|See):\s*(https?:\/\/[^\s)]+)\)/gi;
export const BARE_URL_PATTERN = /(?<![[(])(https?:\/\/[^\s"'>)\]]+)/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateSource(s: string): s is ResearchSource {
  return VALID_SOURCES.has(s);
}

export function filterValidSources(sources: readonly string[]): readonly ResearchSource[] {
  const valid: ResearchSource[] = [];
  for (const s of sources) {
    if (validateSource(s)) {
      valid.push(s);
    }
  }
  return valid;
}

/**
 * Infer a ResearchSource from a URL's hostname.
 */
export function inferSourceFromUrl(url: string): ResearchSource {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("github.com") || hostname.includes("github.io")) return "github";
    if (hostname.includes("reddit.com") || hostname.includes("redd.it")) return "reddit";
    if (hostname.includes("news.ycombinator.com") || hostname.includes("hn.algolia.com")) return "hackernews";
    if (
      hostname.includes("arxiv.org") ||
      hostname.includes("scholar.google") ||
      hostname.includes("semantic") ||
      hostname.includes("doi.org") ||
      hostname.includes("ieee.org") ||
      hostname.includes("acm.org")
    ) {
      return "academic";
    }
  } catch {
    // Invalid URL -- fall through to web
  }
  return "web";
}

/**
 * Deduplicate citations by URL, keeping the first occurrence.
 */
export function deduplicateCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const unique: Citation[] = [];
  for (const c of citations) {
    const normalized = c.url.toLowerCase().replace(/\/+$/, "");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(c);
    }
  }
  return unique;
}

/**
 * Collect text content from a stream of events.
 */
export async function collectStreamText(
  stream: AsyncIterable<StreamEvent>,
): Promise<{ text: string; hasError: boolean; errorMessage: string }> {
  const chunks: string[] = [];
  let hasError = false;
  let errorMessage = "";
  for await (const event of stream) {
    if (event.type === "text" && event.content) {
      chunks.push(event.content);
    } else if (event.type === "error") {
      hasError = true;
      errorMessage = event.error ?? "Unknown error";
    }
  }
  return { text: chunks.join(""), hasError, errorMessage };
}
