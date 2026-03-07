/**
 * FakeBrowserClient -- test double implementing IBrowserClient.
 *
 * Records all method calls and returns pre-configured responses.
 * Used in tests to avoid depending on a real browser.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { Err, Ok } from "@eidolon/protocol";
import type {
  ClickOptions,
  EvalResult,
  FillOptions,
  IBrowserClient,
  NavigateOptions,
  PageSnapshot,
  ScreenshotResult,
} from "./browser-client.ts";

/** Recorded call to the fake browser client. */
export interface FakeBrowserCall {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly timestamp: number;
}

/** Pre-configured page content for a URL pattern. */
interface PageRule {
  readonly urlPattern: RegExp | string;
  readonly snapshot: PageSnapshot;
}

export class FakeBrowserClient implements IBrowserClient {
  private readonly calls: FakeBrowserCall[] = [];
  private readonly pageRules: PageRule[] = [];
  private currentSnapshot: PageSnapshot = { url: "about:blank", title: "", content: "" };
  private connected = true;
  private shouldFailWith: EidolonError | null = null;
  private evalResult: unknown = undefined;

  // ---------------------------------------------------------------------------
  // Configuration methods for tests
  // ---------------------------------------------------------------------------

  /** Add a page rule: when navigating to a URL matching the pattern, return this snapshot. */
  addPageRule(urlPattern: RegExp | string, snapshot: PageSnapshot): void {
    this.pageRules.push({ urlPattern, snapshot });
  }

  /** Set the client to fail all operations with the given error. */
  setFailure(error: EidolonError): void {
    this.shouldFailWith = error;
  }

  /** Clear any configured failure. */
  clearFailure(): void {
    this.shouldFailWith = null;
  }

  /** Set the result returned by evaluate(). */
  setEvalResult(value: unknown): void {
    this.evalResult = value;
  }

  /** Get all recorded calls. */
  getCalls(): readonly FakeBrowserCall[] {
    return this.calls;
  }

  /** Get calls filtered by method name. */
  getCallsByMethod(method: string): readonly FakeBrowserCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Clear recorded calls. */
  clearCalls(): void {
    this.calls.length = 0;
  }

  // ---------------------------------------------------------------------------
  // IBrowserClient implementation
  // ---------------------------------------------------------------------------

  async navigate(url: string, options?: NavigateOptions): Promise<Result<PageSnapshot, EidolonError>> {
    this.record("navigate", [url, options]);

    if (this.shouldFailWith) return Err(this.shouldFailWith);

    const rule = this.findRule(url);
    if (rule) {
      this.currentSnapshot = rule.snapshot;
    } else {
      this.currentSnapshot = { url, title: `Page: ${url}`, content: `<html><body>Content of ${url}</body></html>` };
    }

    return Ok(this.currentSnapshot);
  }

  async snapshot(): Promise<Result<PageSnapshot, EidolonError>> {
    this.record("snapshot", []);

    if (this.shouldFailWith) return Err(this.shouldFailWith);
    return Ok(this.currentSnapshot);
  }

  async click(selector: string, options?: ClickOptions): Promise<Result<void, EidolonError>> {
    this.record("click", [selector, options]);

    if (this.shouldFailWith) return Err(this.shouldFailWith);
    return Ok(undefined);
  }

  async fill(selector: string, value: string, options?: FillOptions): Promise<Result<void, EidolonError>> {
    this.record("fill", [selector, value, options]);

    if (this.shouldFailWith) return Err(this.shouldFailWith);
    return Ok(undefined);
  }

  async screenshot(): Promise<Result<ScreenshotResult, EidolonError>> {
    this.record("screenshot", []);

    if (this.shouldFailWith) return Err(this.shouldFailWith);
    return Ok({
      url: this.currentSnapshot.url,
      base64: "iVBORw0KGgoAAAANSUhEUg==", // minimal valid base64
      width: 1280,
      height: 720,
    });
  }

  async evaluate(script: string): Promise<Result<EvalResult, EidolonError>> {
    this.record("evaluate", [script]);

    if (this.shouldFailWith) return Err(this.shouldFailWith);
    return Ok({ value: this.evalResult });
  }

  async close(): Promise<void> {
    this.record("close", []);
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args, timestamp: Date.now() });
  }

  private findRule(url: string): PageRule | undefined {
    return this.pageRules.find((rule) => {
      if (typeof rule.urlPattern === "string") return url === rule.urlPattern;
      return rule.urlPattern.test(url);
    });
  }
}
