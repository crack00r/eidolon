/**
 * Tests for FakeBrowserClient.
 */

import { describe, expect, it } from "bun:test";
import { createError, ErrorCode } from "@eidolon/protocol";
import { FakeBrowserClient } from "../fake-client.ts";

describe("FakeBrowserClient", () => {
  it("starts connected", () => {
    const client = new FakeBrowserClient();
    expect(client.isConnected()).toBe(true);
  });

  it("navigates and returns default snapshot", async () => {
    const client = new FakeBrowserClient();
    const result = await client.navigate("https://example.com");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toBe("https://example.com");
      expect(result.value.title).toContain("example.com");
    }
  });

  it("uses page rules when navigating", async () => {
    const client = new FakeBrowserClient();
    client.addPageRule(/example\.com/, {
      url: "https://example.com",
      title: "Example Domain",
      content: "<html>Custom content</html>",
    });

    const result = await client.navigate("https://example.com/page");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Example Domain");
      expect(result.value.content).toBe("<html>Custom content</html>");
    }
  });

  it("returns configured failure", async () => {
    const client = new FakeBrowserClient();
    const error = createError(ErrorCode.BROWSER_ACTION_FAILED, "Test error");
    client.setFailure(error);

    const result = await client.navigate("https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.BROWSER_ACTION_FAILED);
    }
  });

  it("records method calls", async () => {
    const client = new FakeBrowserClient();
    await client.navigate("https://example.com");
    await client.click("#button");
    await client.fill("#input", "hello");

    const calls = client.getCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]!.method).toBe("navigate");
    expect(calls[1]!.method).toBe("click");
    expect(calls[2]!.method).toBe("fill");
  });

  it("filters calls by method", async () => {
    const client = new FakeBrowserClient();
    await client.navigate("https://a.com");
    await client.click("#x");
    await client.navigate("https://b.com");

    expect(client.getCallsByMethod("navigate")).toHaveLength(2);
    expect(client.getCallsByMethod("click")).toHaveLength(1);
  });

  it("returns snapshot of current page", async () => {
    const client = new FakeBrowserClient();
    await client.navigate("https://example.com");
    const snap = await client.snapshot();

    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.value.url).toBe("https://example.com");
    }
  });

  it("returns screenshot result", async () => {
    const client = new FakeBrowserClient();
    const result = await client.screenshot();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.base64).toBeTruthy();
      expect(result.value.width).toBe(1280);
      expect(result.value.height).toBe(720);
    }
  });

  it("evaluate returns configured result", async () => {
    const client = new FakeBrowserClient();
    client.setEvalResult(42);

    const result = await client.evaluate("1 + 1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe(42);
    }
  });

  it("close sets connected to false", async () => {
    const client = new FakeBrowserClient();
    expect(client.isConnected()).toBe(true);

    await client.close();
    expect(client.isConnected()).toBe(false);
  });

  it("clearCalls removes recorded calls", async () => {
    const client = new FakeBrowserClient();
    await client.navigate("https://example.com");
    expect(client.getCalls()).toHaveLength(1);

    client.clearCalls();
    expect(client.getCalls()).toHaveLength(0);
  });

  it("clearFailure allows operations to succeed again", async () => {
    const client = new FakeBrowserClient();
    client.setFailure(createError(ErrorCode.BROWSER_ACTION_FAILED, "fail"));

    const fail = await client.navigate("https://example.com");
    expect(fail.ok).toBe(false);

    client.clearFailure();
    const success = await client.navigate("https://example.com");
    expect(success.ok).toBe(true);
  });
});
