export type {
  ClickOptions,
  EvalResult,
  FillOptions,
  IBrowserClient,
  NavigateOptions,
  PageSnapshot,
  ScreenshotResult,
} from "./browser-client.ts";
export type { FakeBrowserCall } from "./fake-client.ts";
export { FakeBrowserClient } from "./fake-client.ts";
export { BrowserManager } from "./manager.ts";
export { PlaywrightClient } from "./playwright-client.ts";
export type { BrowserToolDefinition, BrowserToolName, BrowserToolResult } from "./tools.ts";
export {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  BrowseClickInputSchema,
  BrowseEvaluateInputSchema,
  BrowseFillInputSchema,
  BrowseNavigateInputSchema,
  executeBrowserTool,
} from "./tools.ts";
