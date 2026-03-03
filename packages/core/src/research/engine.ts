/**
 * ResearchEngine -- deep multi-source research with structured citations.
 *
 * Runs a research session via IClaudeProcess, parses the response for
 * structured findings and citations, and returns a structured result.
 * Designed to be triggered from the Cognitive Loop or gateway RPC.
 */

import { randomUUID } from "node:crypto";
import type { ClaudeSessionOptions, EidolonError, IClaudeProcess, Result, StreamEvent } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

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

const DEFAULT_MAX_SOURCES = 10;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_QUERY_LENGTH = 4096;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateSource(s: string): s is ResearchSource {
  return VALID_SOURCES.has(s);
}

function filterValidSources(sources: readonly string[]): readonly ResearchSource[] {
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
function inferSourceFromUrl(url: string): ResearchSource {
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
function deduplicateCitations(citations: Citation[]): Citation[] {
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
async function collectStreamText(
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

// ---------------------------------------------------------------------------
// ResearchEngine
// ---------------------------------------------------------------------------

export class ResearchEngine {
  private readonly claude: IClaudeProcess;
  private readonly config: ResearchEngineConfig;
  private readonly logger: Logger;

  constructor(claude: IClaudeProcess, config: ResearchEngineConfig, logger: Logger) {
    this.claude = claude;
    this.config = config;
    this.logger = logger.child("research");
  }

  /**
   * Run a deep research session.
   *
   * Builds a research prompt from the query and sources, runs it through
   * IClaudeProcess, parses the response for structured findings and
   * citations, and returns a ResearchResult.
   */
  async research(request: ResearchRequest): Promise<Result<ResearchResult, EidolonError>> {
    const researchId = randomUUID();
    const startTime = Date.now();

    // Validate query
    if (!request.query || request.query.trim().length === 0) {
      return Err(createError(ErrorCode.DISCOVERY_FAILED, "Research query must not be empty"));
    }
    if (request.query.length > MAX_QUERY_LENGTH) {
      return Err(
        createError(
          ErrorCode.DISCOVERY_FAILED,
          `Research query exceeds maximum length (${request.query.length} > ${MAX_QUERY_LENGTH})`,
        ),
      );
    }

    // Validate and filter sources
    const validSources = filterValidSources(request.sources);
    const sources: readonly ResearchSource[] = validSources.length > 0 ? validSources : ["web", "academic", "github"];
    const maxSources = Math.max(1, Math.min(request.maxSources || DEFAULT_MAX_SOURCES, this.config.maxSources));

    this.logger.info("research", `Starting research: "${request.query}"`, {
      researchId,
      sourceCount: sources.length,
      maxSources,
    });

    // Build the prompt
    const prompt = this.buildResearchPrompt(request.query, sources);

    // Run through Claude
    const sessionOptions: ClaudeSessionOptions = {
      workspaceDir: this.config.workspaceDir,
      model: this.config.model,
      timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      allowedTools: ["Read", "Glob", "Grep", "WebFetch"],
    };

    try {
      const stream = this.claude.run(prompt, sessionOptions);
      const { text, hasError, errorMessage } = await collectStreamText(stream);

      if (hasError) {
        this.logger.error("research", `Research session error: ${errorMessage}`, undefined, {
          researchId,
        });
        return Err(createError(ErrorCode.DISCOVERY_FAILED, `Research session failed: ${errorMessage}`));
      }

      if (!text || text.trim().length === 0) {
        this.logger.warn("research", "Research session returned empty response", {
          researchId,
        });
        return Ok({
          id: researchId,
          query: request.query,
          findings: [],
          summary: "No results found.",
          citations: [],
          tokensUsed: 0,
          durationMs: Date.now() - startTime,
          completedAt: Date.now(),
        });
      }

      // Parse the response
      const citations = this.parseCitations(text);
      const findings = this.parseFindings(text, citations);
      const summary = this.extractSummary(text);

      const result: ResearchResult = {
        id: researchId,
        query: request.query,
        findings,
        summary,
        citations,
        tokensUsed: 0, // Token tracking delegated to caller
        durationMs: Date.now() - startTime,
        completedAt: Date.now(),
      };

      this.logger.info("research", "Research completed", {
        researchId,
        findingCount: findings.length,
        citationCount: citations.length,
        durationMs: result.durationMs,
      });

      return Ok(result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.logger.error("research", `Research failed: ${message}`, cause, { researchId });
      return Err(createError(ErrorCode.DISCOVERY_FAILED, `Research failed: ${message}`, cause));
    }
  }

  /**
   * Build a research prompt that instructs Claude to research from multiple
   * sources and return structured findings with citations.
   */
  buildResearchPrompt(query: string, sources: readonly ResearchSource[]): string {
    const sourceDescriptions: Record<ResearchSource, string> = {
      web: "general web pages and blogs",
      academic: "academic papers (arXiv, Google Scholar, IEEE, ACM)",
      github: "GitHub repositories, issues, and discussions",
      hackernews: "Hacker News discussions and linked articles",
      reddit: "Reddit posts and discussions from relevant subreddits",
    };

    const sourceList = sources.map((s) => `- ${s}: ${sourceDescriptions[s]}`).join("\n");

    return [
      "You are conducting deep research on the following query.",
      "Provide a comprehensive, well-structured response with citations.",
      "",
      "## Research Query",
      query,
      "",
      "## Sources to Consult",
      sourceList,
      "",
      "## Instructions",
      "1. Search across the specified sources for relevant information.",
      "2. Organize your findings into clear sections, each with a descriptive title.",
      "3. For every claim or piece of information, provide a citation with the source URL.",
      "4. Use markdown link format for citations: [Title](URL)",
      "5. After presenting your findings, provide a concise executive summary.",
      "6. Rate your confidence in each finding (low/medium/high).",
      "",
      "## Output Format",
      "",
      "### Finding: [Title of Finding]",
      "**Confidence:** [low/medium/high]",
      "",
      "[Description of the finding with inline citations using markdown links]",
      "",
      "---",
      "",
      "(Repeat for each finding)",
      "",
      "### Summary",
      "",
      "[2-3 paragraph executive summary of all findings]",
      "",
      "### References",
      "",
      "[Numbered list of all URLs cited, e.g., [1]: https://example.com - Title]",
      "",
      "Begin your research now.",
    ].join("\n");
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
  parseCitations(text: string): readonly Citation[] {
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
          snippet: this.extractSnippetAround(text, match.index ?? 0),
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
          snippet: this.extractSnippetAround(text, match.index ?? 0),
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
          snippet: this.extractSnippetAround(text, match.index ?? 0),
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
          snippet: this.extractSnippetAround(text, match.index ?? 0),
        });
      }
    }

    return deduplicateCitations(citations);
  }

  /**
   * Parse findings from the response text.
   *
   * Looks for "### Finding:" or "## Finding:" section headers and extracts
   * the title, body, confidence, and associated citations.
   */
  private parseFindings(text: string, allCitations: readonly Citation[]): readonly ResearchFinding[] {
    const findings: ResearchFinding[] = [];

    // Match heading patterns like "### Finding: Title" or "## Finding: Title"
    const findingPattern = /^#{2,3}\s+Finding:\s*(.+)$/gm;
    const matches = [...text.matchAll(findingPattern)];

    if (matches.length === 0) {
      // Fallback: if no structured findings, treat the whole response as one
      if (text.trim().length > 0 && allCitations.length > 0) {
        findings.push({
          title: "Research Results",
          summary: this.extractSummary(text),
          citations: allCitations,
          confidence: 0.5,
        });
      }
      return findings;
    }

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      if (!match) continue;

      const title = (match[1] ?? "Untitled Finding").trim();
      const startIndex = (match.index ?? 0) + match[0].length;
      const endIndex = i + 1 < matches.length ? (matches[i + 1]?.index ?? text.length) : text.length;
      const body = text.slice(startIndex, endIndex).trim();

      // Extract confidence from "**Confidence:** high/medium/low"
      const confidence = this.parseConfidence(body);

      // Find citations that appear in this finding's body
      const findingCitations = allCitations.filter((c) => body.includes(c.url) || body.includes(c.title));

      findings.push({
        title,
        summary: this.cleanFindingBody(body),
        citations: findingCitations,
        confidence,
      });
    }

    return findings;
  }

  /**
   * Extract confidence level from finding body text.
   */
  private parseConfidence(body: string): number {
    const confidenceMatch = /\*?\*?Confidence:?\*?\*?\s*(high|medium|low)/i.exec(body);
    if (!confidenceMatch) return 0.5;
    const level = confidenceMatch[1]?.toLowerCase();
    if (level === "high") return 0.9;
    if (level === "medium") return 0.7;
    return 0.4;
  }

  /**
   * Clean a finding body by removing the confidence line and trimming.
   */
  private cleanFindingBody(body: string): string {
    return body
      .replace(/\*?\*?Confidence:?\*?\*?\s*(high|medium|low)\s*/gi, "")
      .replace(/^---+\s*/gm, "")
      .trim()
      .slice(0, 2000); // Limit summary length
  }

  /**
   * Extract the executive summary from the response.
   * Looks for "### Summary" or "## Summary" sections.
   */
  private extractSummary(text: string): string {
    const summaryMatch = /^#{2,3}\s+Summary\s*$([\s\S]*?)(?=^#{2,3}\s|$)/im.exec(text);
    if (summaryMatch?.[1]) {
      return summaryMatch[1].trim().slice(0, 3000);
    }

    // Fallback: take the first few paragraphs
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
    return paragraphs.slice(0, 3).join("\n\n").trim().slice(0, 3000);
  }

  /**
   * Extract a snippet of text around a given index for citation context.
   */
  private extractSnippetAround(text: string, index: number): string {
    const start = Math.max(0, index - 100);
    const end = Math.min(text.length, index + 200);
    let snippet = text.slice(start, end).trim();
    if (start > 0) snippet = `...${snippet}`;
    if (end < text.length) snippet = `${snippet}...`;
    return snippet.slice(0, 300);
  }
}
