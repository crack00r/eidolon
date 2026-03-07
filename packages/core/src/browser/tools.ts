/**
 * BrowserTools -- MCP-style tool definitions for browser automation.
 *
 * These tools are registered as allowed tools for Claude Code sessions,
 * enabling Claude to interact with web pages through the browser manager.
 */

import { z } from "zod";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { BrowserManager } from "./manager.ts";

// ---------------------------------------------------------------------------
// Tool Input Schemas
// ---------------------------------------------------------------------------

export const BrowseNavigateInputSchema = z.object({
  url: z.string().url("Must be a valid URL"),
});

export const BrowseClickInputSchema = z.object({
  selector: z.string().min(1, "Selector must not be empty"),
});

export const BrowseFillInputSchema = z.object({
  selector: z.string().min(1, "Selector must not be empty"),
  value: z.string(),
});

export const BrowseEvaluateInputSchema = z.object({
  script: z.string().min(1, "Script must not be empty"),
});

// ---------------------------------------------------------------------------
// Tool Result Type
// ---------------------------------------------------------------------------

/** Unified result returned by all browser tools. */
export interface BrowserToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Tool Name Constants
// ---------------------------------------------------------------------------

export const BROWSER_TOOL_NAMES = [
  "browse_navigate",
  "browse_click",
  "browse_fill",
  "browse_screenshot",
  "browse_snapshot",
  "browse_evaluate",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Tool Definitions (descriptions for Claude Code)
// ---------------------------------------------------------------------------

export interface BrowserToolDefinition {
  readonly name: BrowserToolName;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

export const BROWSER_TOOL_DEFINITIONS: readonly BrowserToolDefinition[] = [
  {
    name: "browse_navigate",
    description: "Navigate the browser to a URL and return the page content.",
    inputSchema: BrowseNavigateInputSchema,
  },
  {
    name: "browse_click",
    description: "Click an element on the page identified by a CSS selector.",
    inputSchema: BrowseClickInputSchema,
  },
  {
    name: "browse_fill",
    description: "Fill an input field identified by a CSS selector with a value.",
    inputSchema: BrowseFillInputSchema,
  },
  {
    name: "browse_screenshot",
    description: "Take a screenshot of the current page and return it as base64 PNG.",
    inputSchema: z.object({}),
  },
  {
    name: "browse_snapshot",
    description: "Get a text snapshot of the current page (URL, title, HTML content).",
    inputSchema: z.object({}),
  },
  {
    name: "browse_evaluate",
    description: "Evaluate a JavaScript expression in the browser page context.",
    inputSchema: BrowseEvaluateInputSchema,
  },
];

// ---------------------------------------------------------------------------
// Tool Executor
// ---------------------------------------------------------------------------

/**
 * Execute a browser tool by name with the given input.
 * Input is validated against the corresponding Zod schema.
 */
export async function executeBrowserTool(
  manager: BrowserManager,
  toolName: string,
  input: unknown,
): Promise<Result<BrowserToolResult, EidolonError>> {
  switch (toolName) {
    case "browse_navigate":
      return handleNavigate(manager, input);
    case "browse_click":
      return handleClick(manager, input);
    case "browse_fill":
      return handleFill(manager, input);
    case "browse_screenshot":
      return handleScreenshot(manager);
    case "browse_snapshot":
      return handleSnapshot(manager);
    case "browse_evaluate":
      return handleEvaluate(manager, input);
    default:
      return Err(createError(ErrorCode.INVALID_INPUT, `Unknown browser tool: ${toolName}`));
  }
}

// ---------------------------------------------------------------------------
// Individual Handlers
// ---------------------------------------------------------------------------

async function handleNavigate(
  manager: BrowserManager,
  input: unknown,
): Promise<Result<BrowserToolResult, EidolonError>> {
  const parsed = BrowseNavigateInputSchema.safeParse(input);
  if (!parsed.success) {
    return Err(createError(ErrorCode.INVALID_INPUT, `Invalid navigate input: ${parsed.error.message}`));
  }

  const result = await manager.navigate(parsed.data.url);
  if (!result.ok) return Ok({ success: false, error: result.error.message });

  return Ok({ success: true, data: result.value });
}

async function handleClick(
  manager: BrowserManager,
  input: unknown,
): Promise<Result<BrowserToolResult, EidolonError>> {
  const parsed = BrowseClickInputSchema.safeParse(input);
  if (!parsed.success) {
    return Err(createError(ErrorCode.INVALID_INPUT, `Invalid click input: ${parsed.error.message}`));
  }

  const result = await manager.click(parsed.data.selector);
  if (!result.ok) return Ok({ success: false, error: result.error.message });

  return Ok({ success: true });
}

async function handleFill(
  manager: BrowserManager,
  input: unknown,
): Promise<Result<BrowserToolResult, EidolonError>> {
  const parsed = BrowseFillInputSchema.safeParse(input);
  if (!parsed.success) {
    return Err(createError(ErrorCode.INVALID_INPUT, `Invalid fill input: ${parsed.error.message}`));
  }

  const result = await manager.fill(parsed.data.selector, parsed.data.value);
  if (!result.ok) return Ok({ success: false, error: result.error.message });

  return Ok({ success: true });
}

async function handleScreenshot(manager: BrowserManager): Promise<Result<BrowserToolResult, EidolonError>> {
  const result = await manager.screenshot();
  if (!result.ok) return Ok({ success: false, error: result.error.message });

  return Ok({ success: true, data: result.value });
}

async function handleSnapshot(manager: BrowserManager): Promise<Result<BrowserToolResult, EidolonError>> {
  const result = await manager.snapshot();
  if (!result.ok) return Ok({ success: false, error: result.error.message });

  return Ok({ success: true, data: result.value });
}

async function handleEvaluate(
  manager: BrowserManager,
  input: unknown,
): Promise<Result<BrowserToolResult, EidolonError>> {
  const parsed = BrowseEvaluateInputSchema.safeParse(input);
  if (!parsed.success) {
    return Err(createError(ErrorCode.INVALID_INPUT, `Invalid evaluate input: ${parsed.error.message}`));
  }

  const result = await manager.evaluate(parsed.data.script);
  if (!result.ok) return Ok({ success: false, error: result.error.message });

  return Ok({ success: true, data: result.value });
}
