import { describe, expect, test } from "bun:test";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import type { Logger } from "../../logging/logger.ts";
import { ResearchEngine } from "../engine.ts";
import type { ResearchEngineConfig, ResearchRequest, ResearchSource } from "../engine.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function createConfig(overrides?: Partial<ResearchEngineConfig>): ResearchEngineConfig {
  return {
    workspaceDir: "/tmp/eidolon-test-research",
    maxSources: 20,
    ...overrides,
  };
}

function createRequest(overrides?: Partial<ResearchRequest>): ResearchRequest {
  return {
    query: "What are the best approaches to vector search in SQLite?",
    sources: ["web", "github", "academic"] as readonly ResearchSource[],
    maxSources: 10,
    ...overrides,
  };
}

const SAMPLE_RESPONSE_WITH_FINDINGS = `
### Finding: sqlite-vec for Vector Search
**Confidence:** high

The [sqlite-vec](https://github.com/asg017/sqlite-vec) extension provides native vector search capabilities.
It supports cosine similarity and L2 distance metrics. See the [documentation](https://github.com/asg017/sqlite-vec/wiki).

---

### Finding: FTS5 for BM25 Search
**Confidence:** medium

SQLite's built-in [FTS5](https://www.sqlite.org/fts5.html) module provides full-text search with BM25 ranking.
This can be combined with vector search for hybrid retrieval.

---

### Summary

Vector search in SQLite is best achieved through the sqlite-vec extension, which provides efficient
approximate nearest neighbor search. For hybrid search combining keyword and semantic matching,
pairing FTS5 with sqlite-vec using Reciprocal Rank Fusion (RRF) is the recommended approach.

### References

[1]: https://github.com/asg017/sqlite-vec - sqlite-vec repository
[2]: https://www.sqlite.org/fts5.html - SQLite FTS5 documentation
`;

const SAMPLE_RESPONSE_BARE_URLS = `
Some useful resources for SQLite vector search include https://example.com/vector-search and
you can also check https://github.com/test/repo for implementation examples.

There's a discussion on Hacker News at https://news.ycombinator.com/item?id=12345 about this.

Academic paper: (Source: https://arxiv.org/abs/2301.12345)
`;

const SAMPLE_RESPONSE_NO_FINDINGS = `
Here is some general information about vector search.
It uses embeddings to find similar items.
This is a common technique in modern search systems.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResearchEngine", () => {
  const logger = createSilentLogger();

  describe("research", () => {
    test("returns structured findings and citations from a well-formatted response", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, SAMPLE_RESPONSE_WITH_FINDINGS);
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.query).toBe("What are the best approaches to vector search in SQLite?");
      expect(result.value.findings.length).toBeGreaterThanOrEqual(2);
      expect(result.value.citations.length).toBeGreaterThanOrEqual(2);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.value.completedAt).toBeGreaterThan(0);
    });

    test("finding titles are correctly extracted", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, SAMPLE_RESPONSE_WITH_FINDINGS);
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const titles = result.value.findings.map((f) => f.title);
      expect(titles).toContain("sqlite-vec for Vector Search");
      expect(titles).toContain("FTS5 for BM25 Search");
    });

    test("confidence levels are correctly parsed", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, SAMPLE_RESPONSE_WITH_FINDINGS);
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const sqliteVecFinding = result.value.findings.find(
        (f) => f.title === "sqlite-vec for Vector Search",
      );
      expect(sqliteVecFinding?.confidence).toBe(0.9); // high

      const fts5Finding = result.value.findings.find(
        (f) => f.title === "FTS5 for BM25 Search",
      );
      expect(fts5Finding?.confidence).toBe(0.7); // medium
    });

    test("returns empty result for empty response", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, "");
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.findings).toHaveLength(0);
      expect(result.value.citations).toHaveLength(0);
      expect(result.value.summary).toBe("No results found.");
    });

    test("returns error for empty query", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, "response");
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest({ query: "" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("empty");
    });

    test("returns error for query exceeding max length", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, "response");
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const longQuery = "a".repeat(5000);
      const result = await engine.research(createRequest({ query: longQuery }));
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("maximum length");
    });

    test("returns error when Claude process returns an error event", async () => {
      const fake = FakeClaudeProcess.withError("CLAUDE_TIMEOUT", "Research session timed out");
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest());
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("Research session failed");
    });

    test("falls back to default sources when invalid sources are provided", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, SAMPLE_RESPONSE_WITH_FINDINGS);
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(
        createRequest({ sources: ["invalid" as ResearchSource] }),
      );
      expect(result.ok).toBe(true);
      // The prompt should have been built with default sources
      const lastPrompt = fake.getLastPrompt();
      expect(lastPrompt).toContain("web");
    });

    test("passes correct session options to Claude", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, SAMPLE_RESPONSE_WITH_FINDINGS);
      const engine = new ResearchEngine(
        fake,
        createConfig({ model: "claude-opus-4-20250514", timeoutMs: 60_000 }),
        logger,
      );

      await engine.research(createRequest());

      const options = fake.getLastOptions();
      expect(options).toBeDefined();
      expect(options?.model).toBe("claude-opus-4-20250514");
      expect(options?.timeoutMs).toBe(60_000);
      expect(options?.allowedTools).toContain("WebFetch");
    });
  });

  describe("parseCitations", () => {
    test("extracts markdown link citations", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const text = "Check out [sqlite-vec](https://github.com/asg017/sqlite-vec) for vector search.";
      const citations = engine.parseCitations(text);

      expect(citations.length).toBe(1);
      expect(citations[0]?.url).toBe("https://github.com/asg017/sqlite-vec");
      expect(citations[0]?.title).toBe("sqlite-vec");
      expect(citations[0]?.source).toBe("github");
      expect(citations[0]?.relevance).toBe(0.8);
    });

    test("extracts numbered reference citations", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const text = "References:\n[1]: https://example.com/article - Some article\n[2]: https://github.com/test/repo - Repo";
      const citations = engine.parseCitations(text);

      expect(citations.length).toBe(2);
      expect(citations[0]?.url).toBe("https://example.com/article");
      expect(citations[1]?.url).toBe("https://github.com/test/repo");
    });

    test("extracts parenthetical citations", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const text = "As noted in the paper (Source: https://arxiv.org/abs/2301.12345) this approach works.";
      const citations = engine.parseCitations(text);

      expect(citations.length).toBe(1);
      expect(citations[0]?.url).toBe("https://arxiv.org/abs/2301.12345");
      expect(citations[0]?.source).toBe("academic");
    });

    test("extracts bare URLs", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const citations = engine.parseCitations(SAMPLE_RESPONSE_BARE_URLS);

      const urls = citations.map((c) => c.url);
      expect(urls).toContain("https://example.com/vector-search");
      expect(urls).toContain("https://github.com/test/repo");
    });

    test("deduplicates citations by URL", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const text = [
        "See [Article](https://example.com/page) for details.",
        "Also referenced at [1]: https://example.com/page - Same article",
      ].join("\n");
      const citations = engine.parseCitations(text);

      const exampleUrls = citations.filter((c) => c.url.includes("example.com/page"));
      expect(exampleUrls.length).toBe(1);
    });

    test("infers source type from URL hostname", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const text = [
        "[GH](https://github.com/test/repo)",
        "[Reddit](https://reddit.com/r/test/post)",
        "[HN](https://news.ycombinator.com/item?id=123)",
        "[arXiv](https://arxiv.org/abs/2301.12345)",
        "[Blog](https://myblog.com/article)",
      ].join("\n");
      const citations = engine.parseCitations(text);

      const bySource = new Map(citations.map((c) => [c.source, c.url]));
      expect(bySource.get("github")).toContain("github.com");
      expect(bySource.get("reddit")).toContain("reddit.com");
      expect(bySource.get("hackernews")).toContain("ycombinator.com");
      expect(bySource.get("academic")).toContain("arxiv.org");
      expect(bySource.get("web")).toContain("myblog.com");
    });

    test("returns empty array for text with no URLs", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const citations = engine.parseCitations("This is plain text with no links at all.");
      expect(citations).toHaveLength(0);
    });
  });

  describe("buildResearchPrompt", () => {
    test("includes the query in the prompt", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const prompt = engine.buildResearchPrompt("test query", ["web"]);
      expect(prompt).toContain("test query");
    });

    test("includes all specified sources", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const sources: readonly ResearchSource[] = ["web", "github", "academic"];
      const prompt = engine.buildResearchPrompt("query", sources);

      expect(prompt).toContain("web:");
      expect(prompt).toContain("github:");
      expect(prompt).toContain("academic:");
    });

    test("includes output format instructions", () => {
      const fake = new FakeClaudeProcess();
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const prompt = engine.buildResearchPrompt("query", ["web"]);
      expect(prompt).toContain("### Finding:");
      expect(prompt).toContain("### Summary");
      expect(prompt).toContain("### References");
      expect(prompt).toContain("Confidence");
    });
  });

  describe("fallback finding parsing", () => {
    test("creates a single finding when no structured findings exist but citations are present", async () => {
      const responseWithUrlsOnly = "Check https://example.com/article for more information about vector search.";
      const fake = FakeClaudeProcess.withResponse(/./, responseWithUrlsOnly);
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.findings.length).toBe(1);
      expect(result.value.findings[0]?.title).toBe("Research Results");
      expect(result.value.findings[0]?.confidence).toBe(0.5);
    });

    test("returns no findings when response has no citations and no structure", async () => {
      const fake = FakeClaudeProcess.withResponse(/./, SAMPLE_RESPONSE_NO_FINDINGS);
      const engine = new ResearchEngine(fake, createConfig(), logger);

      const result = await engine.research(createRequest());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.findings).toHaveLength(0);
    });
  });
});
