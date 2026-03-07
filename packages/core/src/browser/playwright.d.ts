/**
 * Ambient module declaration for the optional playwright dependency.
 *
 * Playwright is loaded via dynamic import at runtime; this declaration
 * satisfies TypeScript without requiring the package to be installed.
 * Only the subset of the API actually used by playwright-client.ts is typed.
 */
declare module "playwright" {
  interface LaunchPersistentContextOptions {
    headless?: boolean;
    viewport?: { width: number; height: number } | null;
  }

  interface Page {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    title(): Promise<string>;
    url(): string;
    content(): Promise<string>;
    click(selector: string, options?: { button?: string; clickCount?: number; timeout?: number }): Promise<void>;
    fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
    screenshot(options?: { type?: string; fullPage?: boolean }): Promise<Buffer>;
    evaluate<T>(pageFunction: string | (() => T)): Promise<T>;
    viewportSize(): { width: number; height: number } | null;
    setViewportSize(size: { width: number; height: number }): Promise<void>;
  }

  interface BrowserContext {
    newPage(): Promise<Page>;
    pages(): Page[];
    close(): Promise<void>;
  }

  interface BrowserType {
    launchPersistentContext(userDataDir: string, options?: LaunchPersistentContextOptions): Promise<BrowserContext>;
  }

  export const chromium: BrowserType;
}
