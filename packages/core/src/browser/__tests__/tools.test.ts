/**
 * Tests for browser tools executor.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import type { BrowserConfig } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { FakeBrowserClient } from "../fake-client.ts";
import { BrowserManager } from "../manager.ts";
import { executeBrowserTool, BROWSER_TOOL_NAMES, BROWSER_TOOL_DEFINITIONS } from "../tools.ts";

function makeConfig(): BrowserConfig {
  return {
    enabled: true,
    headless: true,
    profilePath: "/tmp/test-profile",
    defaultTimeoutMs: 5000,
    viewport: { width: 1280, height: 720 },
    maxTabs: 5,
  };
}

describe("executeBrowserTool", () => {
  let client: FakeBrowserClient;
  let manager: BrowserManager;

  beforeEach(() => {
    client = new FakeBrowserClient();
    manager = new BrowserManager(client, makeConfig(), createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 }));
    manager.start();
  });

  it("browse_navigate navigates to URL", async () => {
    const result = await executeBrowserTool(manager, "browse_navigate", { url: "https://example.com" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });

  it("browse_navigate rejects invalid URL", async () => {
    const result = await executeBrowserTool(manager, "browse_navigate", { url: "not-a-url" });
    expect(result.ok).toBe(false);
  });

  it("browse_click clicks element", async () => {
    const result = await executeBrowserTool(manager, "browse_click", { selector: "#button" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });

  it("browse_click rejects empty selector", async () => {
    const result = await executeBrowserTool(manager, "browse_click", { selector: "" });
    expect(result.ok).toBe(false);
  });

  it("browse_fill fills input", async () => {
    const result = await executeBrowserTool(manager, "browse_fill", {
      selector: "#input",
      value: "hello world",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });

  it("browse_screenshot takes screenshot", async () => {
    const result = await executeBrowserTool(manager, "browse_screenshot", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.data).toBeTruthy();
    }
  });

  it("browse_snapshot returns page content", async () => {
    const result = await executeBrowserTool(manager, "browse_snapshot", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });

  it("browse_evaluate runs script", async () => {
    client.setEvalResult("hello");
    const result = await executeBrowserTool(manager, "browse_evaluate", { script: "document.title" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });

  it("unknown tool returns error", async () => {
    const result = await executeBrowserTool(manager, "browse_unknown", {});
    expect(result.ok).toBe(false);
  });

  it("BROWSER_TOOL_NAMES has 6 tools", () => {
    expect(BROWSER_TOOL_NAMES).toHaveLength(6);
  });

  it("BROWSER_TOOL_DEFINITIONS matches tool names", () => {
    const names = BROWSER_TOOL_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual([...BROWSER_TOOL_NAMES]);
  });
});
