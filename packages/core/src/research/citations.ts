/**
 * Citation parsing utilities for the research engine.
 *
 * Extracts citations from research response text using multiple formats:
 * markdown links, numbered references, parenthetical references, and bare URLs.
 */

import type { Citation, ResearchSource } from "./types.ts";

/**
 * Regex patterns for extracting citations from text.
 * Supports formats:
 *  - Markdown links: [title](url)
 *  - Numbered refs: [1] url or [1]: url
 *  - Parenthetical: (Source: url)
 *  - Bare URLs: https://...
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const NUMBERED_REF_PATTERN = /\[(\d+)\]:?\s+(https?:\/\/[^\s]+)/g;
const PARENTHETICAL_PATTERN = /\((?:Source|Ref|Reference|Citation|See):\s*(https?:\/\/[^\s)]+)\)/gi;
const BARE_URL_PATTERN = /(?<![[(])(https?:\/\/[^\s"'>)\]]+)/g;

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
 * Extract a snippet of text around a given index for citation context.
 */
export function extractSnippetAround(text: string, index: number): string {
  const start = Math.max(0, index - 100);
  const end = Math.min(text.length, index + 200);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet.slice(0, 300);
}

/**
 * Parse citations from response text.
 *
 * Extracts citations from multiple formats:
 * - Markdown links: [title](url)
 * - Numbered references: [1]: url
 * - Parenthetical references: (Source: url)
 * - Bare URLs as a fallback
 */
export function parseCitations(text: string): readonly Citation[] {
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();

  // 1. Markdown links: [title](url)
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const title = match[1] ?? "";
    const url = match[2] ?? "";
    if (url && !seenUrls.has(url.toLowerCase())) {
      seenUrls.add(url.toLowerCase());
      citations.push({
        url,
        title: title.trim(),
        source: inferSourceFromUrl(url),
        relevance: 0.8,
        snippet: extractSnippetAround(text, match.index ?? 0),
      });
    }
  }

  // 2. Numbered references: [1]: url or [1] url
  for (const match of text.matchAll(NUMBERED_REF_PATTERN)) {
    const url = match[2] ?? "";
    if (url && !seenUrls.has(url.toLowerCase())) {
      seenUrls.add(url.toLowerCase());
      citations.push({
        url,
        title: `Reference ${match[1]}`,
        source: inferSourceFromUrl(url),
        relevance: 0.7,
        snippet: extractSnippetAround(text, match.index ?? 0),
      });
    }
  }

  // 3. Parenthetical: (Source: url)
  for (const match of text.matchAll(PARENTHETICAL_PATTERN)) {
    const url = match[1] ?? "";
    if (url && !seenUrls.has(url.toLowerCase())) {
      seenUrls.add(url.toLowerCase());
      citations.push({
        url,
        title: "Referenced source",
        source: inferSourceFromUrl(url),
        relevance: 0.6,
        snippet: extractSnippetAround(text, match.index ?? 0),
      });
    }
  }

  // 4. Bare URLs (lowest priority, only if not already captured)
  for (const match of text.matchAll(BARE_URL_PATTERN)) {
    const url = match[0] ?? "";
    if (url && !seenUrls.has(url.toLowerCase())) {
      seenUrls.add(url.toLowerCase());
      citations.push({
        url,
        title: "Referenced link",
        source: inferSourceFromUrl(url),
        relevance: 0.5,
        snippet: extractSnippetAround(text, match.index ?? 0),
      });
    }
  }

  return deduplicateCitations(citations);
}
