/**
 * PlaywrightClient -- production IBrowserClient using Playwright.
 *
 * Lazily launches a Chromium browser with a persistent profile.
 * Playwright is an optional dependency -- import failures are
 * caught and surfaced as Result errors.
 */

import type { BrowserConfig, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type {
  ClickOptions,
  EvalResult,
  FillOptions,
  IBrowserClient,
  NavigateOptions,
  PageSnapshot,
  ScreenshotResult,
} from "./browser-client.ts";

/** Minimal Playwright types to avoid importing playwright at the type level. */
interface PwBrowser {
  close(): Promise<void>;
  isConnected(): boolean;
}

interface PwPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  content(): Promise<string>;
  click(selector: string, options?: { button?: string; clickCount?: number; timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  screenshot(options?: { type?: string; fullPage?: boolean }): Promise<Buffer>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  viewportSize(): { width: number; height: number } | null;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
}

interface PwContext {
  newPage(): Promise<PwPage>;
  pages(): PwPage[];
  close(): Promise<void>;
}

interface PwChromium {
  launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<PwContext>;
}

interface PwModule {
  chromium: PwChromium;
}

export class PlaywrightClient implements IBrowserClient {
  private context: PwContext | null = null;
  private page: PwPage | null = null;
  private browser: PwBrowser | null = null;
  private readonly config: BrowserConfig;
  private readonly logger: Logger;

  constructor(config: BrowserConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child("browser:playwright");
  }

  private async ensureBrowser(): Promise<Result<PwPage, EidolonError>> {
    if (this.page && this.context) {
      return Ok(this.page);
    }

    try {
      // Dynamic import so Playwright is truly optional
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pw = (await import(/* webpackIgnore: true */ "playwright" as string)) as unknown as PwModule;

      const profilePath = this.config.profilePath || this.defaultProfilePath();

      this.context = await pw.chromium.launchPersistentContext(profilePath, {
        headless: this.config.headless,
        viewport: {
          width: this.config.viewport.width,
          height: this.config.viewport.height,
        },
      });

      const pages = this.context.pages();
      const firstPage = pages[0];
      this.page = firstPage ?? (await this.context.newPage());
      this.logger.info("browser", "Browser launched", { headless: this.config.headless, profilePath });

      return Ok(this.page);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      if (message.includes("Cannot find module") || message.includes("playwright")) {
        return Err(
          createError(ErrorCode.DEPENDENCY_MISSING, "Playwright is not installed. Run: pnpm add playwright", cause),
        );
      }

      return Err(createError(ErrorCode.BROWSER_ACTION_FAILED, `Failed to launch browser: ${message}`, cause));
    }
  }

  private defaultProfilePath(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
    return `${home}/.eidolon/browser-profile`;
  }

  async navigate(url: string, options?: NavigateOptions): Promise<Result<PageSnapshot, EidolonError>> {
    const pageResult = await this.ensureBrowser();
    if (!pageResult.ok) return pageResult;
    const page = pageResult.value;

    try {
      await page.goto(url, {
        waitUntil: options?.waitUntil ?? "domcontentloaded",
        timeout: options?.timeoutMs ?? this.config.defaultTimeoutMs,
      });

      const title = await page.title();
      const content = await page.content();

      return Ok({ url: page.url(), title, content });
    } catch (cause) {
      return Err(createError(ErrorCode.BROWSER_ACTION_FAILED, `Navigation failed: ${url}`, cause));
    }
  }

  async snapshot(): Promise<Result<PageSnapshot, EidolonError>> {
    const pageResult = await this.ensureBrowser();
    if (!pageResult.ok) return pageResult;
    const page = pageResult.value;

    try {
      const title = await page.title();
      const content = await page.content();
      return Ok({ url: page.url(), title, content });
    } catch (cause) {
      return Err(createError(ErrorCode.BROWSER_ACTION_FAILED, "Failed to get page snapshot", cause));
    }
  }

  async click(selector: string, options?: ClickOptions): Promise<Result<void, EidolonError>> {
    const pageResult = await this.ensureBrowser();
    if (!pageResult.ok) return pageResult;
    const page = pageResult.value;

    try {
      await page.click(selector, {
        button: options?.button,
        clickCount: options?.clickCount,
        timeout: options?.timeoutMs ?? this.config.defaultTimeoutMs,
      });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.BROWSER_ACTION_FAILED, `Click failed on "${selector}"`, cause));
    }
  }

  async fill(selector: string, value: string, options?: FillOptions): Promise<Result<void, EidolonError>> {
    const pageResult = await this.ensureBrowser();
    if (!pageResult.ok) return pageResult;
    const page = pageResult.value;

    try {
      await page.fill(selector, value, {
        timeout: options?.timeoutMs ?? this.config.defaultTimeoutMs,
      });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.BROWSER_ACTION_FAILED, `Fill failed on "${selector}"`, cause));
    }
  }

  async screenshot(): Promise<Result<ScreenshotResult, EidolonError>> {
    const pageResult = await this.ensureBrowser();
    if (!pageResult.ok) return pageResult;
    const page = pageResult.value;

    try {
      const buffer = await page.screenshot({ type: "png", fullPage: false });
      const base64 = buffer.toString("base64");
      const viewport = page.viewportSize() ?? {
        width: this.config.viewport.width,
        height: this.config.viewport.height,
      };

      return Ok({
        url: page.url(),
        base64,
        width: viewport.width,
        height: viewport.height,
      });
    } catch (cause) {
      return Err(createError(ErrorCode.BROWSER_ACTION_FAILED, "Screenshot failed", cause));
    }
  }

  async evaluate(script: string): Promise<Result<EvalResult, EidolonError>> {
    const pageResult = await this.ensureBrowser();
    if (!pageResult.ok) return pageResult;
    const page = pageResult.value;

    try {
      const value: unknown = await page.evaluate(script);
      return Ok({ value });
    } catch (cause) {
      return Err(createError(ErrorCode.BROWSER_ACTION_FAILED, "Script evaluation failed", cause));
    }
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await this.context.close();
      }
    } catch {
      // Best-effort cleanup
    } finally {
      this.context = null;
      this.page = null;
      this.browser = null;
    }
    this.logger.info("browser", "Browser closed");
  }

  isConnected(): boolean {
    if (this.browser) return this.browser.isConnected();
    return this.context !== null;
  }
}
