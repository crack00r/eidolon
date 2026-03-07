/**
 * Tests for McpDiscovery.
 */

import { describe, expect, test } from "bun:test";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import type { Logger } from "../../../logging/logger.ts";
import { McpDiscovery } from "../discovery.ts";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpDiscovery", () => {
  describe("matchKeywords", () => {
    test("matches by template name", () => {
      const claude = new FakeClaudeProcess();
      const discovery = new McpDiscovery(claude, createSilentLogger());

      const matches = discovery.matchKeywords("I need GitHub access");
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0]?.templateId).toBe("github");
    });

    test("matches by tag", () => {
      const claude = new FakeClaudeProcess();
      const discovery = new McpDiscovery(claude, createSilentLogger());

      const matches = discovery.matchKeywords("I need database access");
      expect(matches.length).toBeGreaterThanOrEqual(1);
      const ids = matches.map((m) => m.templateId);
      expect(ids.some((id) => id === "sqlite" || id === "postgres")).toBe(true);
    });

    test("returns empty for no match", () => {
      const claude = new FakeClaudeProcess();
      const discovery = new McpDiscovery(claude, createSilentLogger());

      const matches = discovery.matchKeywords("zzz_no_match_zzz");
      expect(matches).toHaveLength(0);
    });

    test("matches are sorted by confidence", () => {
      const claude = new FakeClaudeProcess();
      const discovery = new McpDiscovery(claude, createSilentLogger());

      const matches = discovery.matchKeywords("Notion notes wiki");
      expect(matches.length).toBeGreaterThanOrEqual(1);

      // Verify sorted
      for (let i = 1; i < matches.length; i++) {
        const prev = matches[i - 1];
        const curr = matches[i];
        if (prev && curr) {
          expect(prev.confidence).toBeGreaterThanOrEqual(curr.confidence);
        }
      }
    });

    test("limits to max 5 results", () => {
      const claude = new FakeClaudeProcess();
      const discovery = new McpDiscovery(claude, createSilentLogger());

      // A very broad search that could match many templates
      const matches = discovery.matchKeywords("server");
      expect(matches.length).toBeLessThanOrEqual(5);
    });
  });

  describe("matchIntent (LLM-based)", () => {
    test("parses valid LLM response", async () => {
      const claude = FakeClaudeProcess.withResponse(
        /MCP.*recommendation/,
        JSON.stringify({
          matches: [
            { templateId: "notion", confidence: 0.9, reasoning: "User wants Notion access" },
            { templateId: "github", confidence: 0.4, reasoning: "Might need code access" },
          ],
        }),
      );

      const discovery = new McpDiscovery(claude, createSilentLogger());
      const result = await discovery.matchIntent("I need access to my Notion database");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.length).toBe(2);
      expect(result.value[0]?.templateId).toBe("notion");
      expect(result.value[0]?.confidence).toBe(0.9);
    });

    test("handles JSON wrapped in code blocks", async () => {
      const claude = FakeClaudeProcess.withResponse(
        /MCP.*recommendation/,
        '```json\n{"matches": [{"templateId": "slack", "confidence": 0.85, "reasoning": "Slack messaging"}]}\n```',
      );

      const discovery = new McpDiscovery(claude, createSilentLogger());
      const result = await discovery.matchIntent("I want to send messages to my team");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.templateId).toBe("slack");
    });

    test("filters out unknown template IDs", async () => {
      const claude = FakeClaudeProcess.withResponse(
        /MCP.*recommendation/,
        JSON.stringify({
          matches: [
            { templateId: "notion", confidence: 0.9, reasoning: "Valid" },
            { templateId: "unknown-server-xyz", confidence: 0.8, reasoning: "Hallucinated" },
          ],
        }),
      );

      const discovery = new McpDiscovery(claude, createSilentLogger());
      const result = await discovery.matchIntent("Notion access");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.templateId).toBe("notion");
    });

    test("handles empty matches", async () => {
      const claude = FakeClaudeProcess.withResponse(
        /MCP.*recommendation/,
        '{"matches": []}',
      );

      const discovery = new McpDiscovery(claude, createSilentLogger());
      const result = await discovery.matchIntent("Something completely unrelated to any MCP server");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    test("returns error for unparseable response", async () => {
      const claude = FakeClaudeProcess.withResponse(
        /MCP.*recommendation/,
        "I cannot provide JSON output right now.",
      );

      const discovery = new McpDiscovery(claude, createSilentLogger());
      const result = await discovery.matchIntent("test");

      expect(result.ok).toBe(false);
    });

    test("returns error for invalid JSON structure", async () => {
      const claude = FakeClaudeProcess.withResponse(
        /MCP.*recommendation/,
        '{"wrong_key": "value"}',
      );

      const discovery = new McpDiscovery(claude, createSilentLogger());
      const result = await discovery.matchIntent("test");

      expect(result.ok).toBe(false);
    });
  });
});
