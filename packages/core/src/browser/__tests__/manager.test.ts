/**
 * Tests for BrowserManager.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { BrowserConfig } from "@eidolon/protocol";
import { ErrorCode } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { FakeBrowserClient } from "../fake-client.ts";
import { BrowserManager } from "../manager.ts";

function makeConfig(overrides?: Partial<BrowserConfig>): BrowserConfig {
  return {
    enabled: true,
    headless: true,
    profilePath: "/tmp/test-profile",
    defaultTimeoutMs: 5000,
    viewport: { width: 1280, height: 720 },
    maxTabs: 5,
    ...overrides,
  };
}

describe("BrowserManager", () => {
  let client: FakeBrowserClient;
  let manager: BrowserManager;

  beforeEach(() => {
    client = new FakeBrowserClient();
    manager = new BrowserManager(
      client,
      makeConfig(),
      createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 }),
    );
  });

  it("isEnabled returns true when config.enabled is true", () => {
    expect(manager.isEnabled()).toBe(true);
  });

  it("isEnabled returns false when config.enabled is false", () => {
    const m = new BrowserManager(
      client,
      makeConfig({ enabled: false }),
      createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 }),
    );
    expect(m.isEnabled()).toBe(false);
  });

  it("start fails when not enabled", () => {
    const m = new BrowserManager(
      client,
      makeConfig({ enabled: false }),
      createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 }),
    );
    const result = m.start();
    expect(result.ok).toBe(false);
  });

  it("start succeeds when enabled", () => {
    const result = manager.start();
    expect(result.ok).toBe(true);
  });

  it("start is idempotent", () => {
    manager.start();
    const result = manager.start();
    expect(result.ok).toBe(true);
  });

  it("navigate fails when not started", async () => {
    const result = await manager.navigate("https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.BROWSER_NOT_STARTED);
    }
  });

  it("navigate works when started", async () => {
    manager.start();
    const result = await manager.navigate("https://example.com");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toBe("https://example.com");
    }
  });

  it("snapshot returns current page", async () => {
    manager.start();
    await manager.navigate("https://example.com");
    const result = await manager.snapshot();
    expect(result.ok).toBe(true);
  });

  it("click delegates to client", async () => {
    manager.start();
    const result = await manager.click("#button");
    expect(result.ok).toBe(true);
    expect(client.getCallsByMethod("click")).toHaveLength(1);
  });

  it("fill delegates to client", async () => {
    manager.start();
    const result = await manager.fill("#input", "hello");
    expect(result.ok).toBe(true);
    expect(client.getCallsByMethod("fill")).toHaveLength(1);
  });

  it("screenshot returns result", async () => {
    manager.start();
    const result = await manager.screenshot();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.base64).toBeTruthy();
    }
  });

  it("evaluate returns script result", async () => {
    manager.start();
    client.setEvalResult({ answer: 42 });
    const result = await manager.evaluate("window.answer");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ answer: 42 });
    }
  });

  it("stop cleans up and prevents further operations", async () => {
    manager.start();
    expect(manager.isRunning()).toBe(true);

    await manager.stop();
    expect(manager.isRunning()).toBe(false);

    const result = await manager.navigate("https://example.com");
    expect(result.ok).toBe(false);
  });

  it("stop is idempotent", async () => {
    manager.start();
    await manager.stop();
    await manager.stop(); // should not throw
  });

  it("getClient returns the underlying client", () => {
    expect(manager.getClient()).toBe(client);
  });
});
