/**
 * ResearchEngine -- deep multi-source research with structured citations.
 *
 * Runs a research session via IClaudeProcess, parses the response for
 * structured findings and citations, and returns a structured result.
 * Designed to be triggered from the Cognitive Loop or gateway RPC.
 *
 * Types, constants, and helpers are in engine-helpers.ts.
 */

import { randomUUID } from "node:crypto";
import type { ClaudeSessionOptions, EidolonError, IClaudeProcess, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type {
  Citation,
  ResearchEngineConfig,
  ResearchFinding,
  ResearchRequest,
  ResearchResult,
  ResearchSource,
} from "./engine-helpers.ts";
import {
  BARE_URL_PATTERN,
  collectStreamText,
  DEFAULT_MAX_SOURCES,
  DEFAULT_TIMEOUT_MS,
  deduplicateCitations,
  filterValidSources,
  inferSourceFromUrl,
  MARKDOWN_LINK_PATTERN,
  MAX_QUERY_LENGTH,
  NUMBERED_REF_PATTERN,
  PARENTHETICAL_PATTERN,
} from "./engine-helpers.ts";

// Re-export all types and helpers for backward compatibility
export type {
  Citation,
  ResearchEngineConfig,
  ResearchFinding,
  ResearchRequest,
  ResearchResult,
  ResearchSource,
} from "./engine-helpers.ts";
export {
  collectStreamText,
  DEFAULT_MAX_SOURCES,
  DEFAULT_TIMEOUT_MS,
  deduplicateCitations,
  filterValidSources,
  inferSourceFromUrl,
  MAX_QUERY_LENGTH,
} from "./engine-helpers.ts";

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
   */
  private parseFindings(text: string, allCitations: readonly Citation[]): readonly ResearchFinding[] {
    const findings: ResearchFinding[] = [];
    const findingPattern = /^#{2,3}\s+Finding:\s*(.+)$/gm;
    const matches = [...text.matchAll(findingPattern)];

    if (matches.length === 0) {
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
      const confidence = this.parseConfidence(body);
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

  /** Extract confidence level from finding body text. */
  private parseConfidence(body: string): number {
    const confidenceMatch = /\*?\*?Confidence:?\*?\*?\s*(high|medium|low)/i.exec(body);
    if (!confidenceMatch) return 0.5;
    const level = confidenceMatch[1]?.toLowerCase();
    if (level === "high") return 0.9;
    if (level === "medium") return 0.7;
    return 0.4;
  }

  /** Clean a finding body by removing the confidence line and trimming. */
  private cleanFindingBody(body: string): string {
    return body
      .replace(/\*?\*?Confidence:?\*?\*?\s*(high|medium|low)\s*/gi, "")
      .replace(/^---+\s*/gm, "")
      .trim()
      .slice(0, 2000);
  }

  /** Extract the executive summary from the response. */
  private extractSummary(text: string): string {
    const summaryMatch = /^#{2,3}\s+Summary\s*$([\s\S]*?)(?=^#{2,3}\s|$)/im.exec(text);
    if (summaryMatch?.[1]) {
      return summaryMatch[1].trim().slice(0, 3000);
    }
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
    return paragraphs.slice(0, 3).join("\n\n").trim().slice(0, 3000);
  }

  /** Extract a snippet of text around a given index for citation context. */
  private extractSnippetAround(text: string, index: number): string {
    const start = Math.max(0, index - 100);
    const end = Math.min(text.length, index + 200);
    let snippet = text.slice(start, end).trim();
    if (start > 0) snippet = `...${snippet}`;
    if (end < text.length) snippet = `${snippet}...`;
    return snippet.slice(0, 300);
  }
}
