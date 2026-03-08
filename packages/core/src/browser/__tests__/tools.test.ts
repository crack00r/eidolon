/**
 * Tests for browser tools executor.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { BrowserConfig } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { FakeBrowserClient } from "../fake-client.ts";
import { BrowserManager } from "../manager.ts";
import { BROWSER_TOOL_DEFINITIONS, BROWSER_TOOL_NAMES, executeBrowserTool, validateEvaluateScript } from "../tools.ts";

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
    manager = new BrowserManager(
      client,
      makeConfig(),
      createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 }),
    );
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

  // --- Security blocklist tests ---
  // These tests verify that the evaluate blocklist correctly REJECTS dangerous scripts.
  // The dangerous strings are test inputs (not executed), validating our security check works.

  it("browse_evaluate blocks fetch calls", async () => {
    const result = await executeBrowserTool(manager, "browse_evaluate", { script: "fetch('/api')" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECURITY_BLOCKED");
    }
  });

  it("browse_evaluate blocks document.cookie access", async () => {
    const result = await executeBrowserTool(manager, "browse_evaluate", { script: "document.cookie" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECURITY_BLOCKED");
    }
  });

  it("browse_evaluate blocks localStorage access", async () => {
    const result = await executeBrowserTool(manager, "browse_evaluate", { script: "localStorage.getItem('x')" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECURITY_BLOCKED");
    }
  });

  it("browse_evaluate blocks XMLHttpRequest", async () => {
    const result = await executeBrowserTool(manager, "browse_evaluate", { script: "new XMLHttpRequest()" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECURITY_BLOCKED");
    }
  });

  it("browse_evaluate blocks dynamic import", async () => {
    const result = await executeBrowserTool(manager, "browse_evaluate", { script: "import('module')" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECURITY_BLOCKED");
    }
  });

  it("browse_evaluate blocks WebSocket", async () => {
    const result = await executeBrowserTool(manager, "browse_evaluate", { script: "new WebSocket('ws://x.com')" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SECURITY_BLOCKED");
    }
  });

  it("browse_evaluate allows safe scripts", async () => {
    client.setEvalResult(42);
    const result = await executeBrowserTool(manager, "browse_evaluate", {
      script: "document.querySelectorAll('a').length",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });
});

describe("validateEvaluateScript", () => {
  it("returns undefined for safe scripts", () => {
    expect(validateEvaluateScript("document.title")).toBeUndefined();
    expect(validateEvaluateScript("document.querySelectorAll('div').length")).toBeUndefined();
    expect(validateEvaluateScript("1 + 2")).toBeUndefined();
  });

  it("returns reason string for blocked patterns", () => {
    // Validate that blocked patterns produce a non-empty reason string
    expect(typeof validateEvaluateScript("fetch('/api')")).toBe("string");
    expect(typeof validateEvaluateScript("document.cookie")).toBe("string");
    expect(typeof validateEvaluateScript("localStorage.getItem('x')")).toBe("string");
    expect(typeof validateEvaluateScript("sessionStorage.setItem('x', 'y')")).toBe("string");
    expect(typeof validateEvaluateScript("indexedDB.open('db')")).toBe("string");
    expect(typeof validateEvaluateScript("navigator.sendBeacon('/log', data)")).toBe("string");
    expect(typeof validateEvaluateScript("window.postMessage('msg', '*')")).toBe("string");
  });
});
