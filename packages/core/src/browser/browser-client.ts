/**
 * IBrowserClient -- abstraction for browser automation.
 *
 * All browser operations return Result types for expected failures.
 * Implementations: PlaywrightClient (production), FakeBrowserClient (tests).
 */

import type { EidolonError, Result } from "@eidolon/protocol";

/** Accessibility tree snapshot of the current page (text-based, not visual). */
export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly content: string;
}

/** Screenshot result as a base64-encoded PNG image. */
export interface ScreenshotResult {
  readonly url: string;
  readonly base64: string;
  readonly width: number;
  readonly height: number;
}

/** Result of evaluating a JavaScript expression in the browser context. */
export interface EvalResult {
  readonly value: unknown;
}

/** Navigation options for page loading. */
export interface NavigateOptions {
  readonly waitUntil?: "load" | "domcontentloaded" | "networkidle";
  readonly timeoutMs?: number;
}

/** Options for click actions. */
export interface ClickOptions {
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
  readonly timeoutMs?: number;
}

/** Options for fill/type actions. */
export interface FillOptions {
  readonly timeoutMs?: number;
  readonly clear?: boolean;
}

/**
 * Browser client interface for browser automation.
 *
 * All methods use the Result pattern for expected failures
 * (element not found, navigation timeout, etc.).
 */
export interface IBrowserClient {
  /** Navigate to a URL. */
  navigate(url: string, options?: NavigateOptions): Promise<Result<PageSnapshot, EidolonError>>;

  /** Get an accessibility snapshot of the current page (text content). */
  snapshot(): Promise<Result<PageSnapshot, EidolonError>>;

  /** Click an element matching the given selector. */
  click(selector: string, options?: ClickOptions): Promise<Result<void, EidolonError>>;

  /** Fill an input element with the given value. */
  fill(selector: string, value: string, options?: FillOptions): Promise<Result<void, EidolonError>>;

  /** Take a screenshot of the current page. */
  screenshot(): Promise<Result<ScreenshotResult, EidolonError>>;

  /** Evaluate a JavaScript expression in the page context. */
  evaluate(script: string): Promise<Result<EvalResult, EidolonError>>;

  /** Close the browser. */
  close(): Promise<void>;

  /** Whether the browser is currently connected/running. */
  isConnected(): boolean;
}
