/**
 * API call step executor.
 *
 * Makes HTTP requests to external APIs. Respects abort signals for cancellation.
 * Uses native fetch -- no shell commands.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { ApiCallConfigSchema } from "../types.ts";

/** URL schemes that are blocked to prevent SSRF attacks. */
const BLOCKED_URL_SCHEMES = ["file:", "javascript:", "data:", "ftp:", "gopher:"];

/** Private/internal IP patterns that should not be reachable from workflow API calls. */
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/127\./,
  /^https?:\/\/0\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/localhost[:/]/,
  /^https?:\/\/localhost$/,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[::\]/,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/\[fd/i,
  /^https?:\/\/\[fe80:/i,
];

/** Hostnames that are always blocked (cloud metadata endpoints). */
const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "instance-data"]);

/** Validate that a URL is safe for outbound HTTP requests. */
function validateUrl(url: string): string | undefined {
  const lower = url.toLowerCase();
  for (const scheme of BLOCKED_URL_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return `Blocked URL scheme: ${scheme}`;
    }
  }
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(lower)) {
      return "Requests to private/internal IP addresses are not allowed";
    }
  }
  // Block cloud metadata hostnames
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/]$/, "").toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return `Blocked hostname: ${hostname} (SSRF protection)`;
    }
  } catch {
    return "Invalid URL";
  }
  return undefined;
}

export class ApiStepExecutor implements IStepExecutor {
  readonly type = "api_call" as const;

  async execute(
    config: StepConfig,
    _context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = ApiCallConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid api_call config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { url, method, headers, body } = parsed.data;

    // SSRF prevention: reject dangerous URL schemes and private IPs
    const urlBlockedReason = validateUrl(url);
    if (urlBlockedReason) {
      return Err(createError(ErrorCode.SECURITY_BLOCKED, `API call blocked: ${urlBlockedReason}`));
    }

    try {
      const response = await fetch(url, {
        method,
        headers: headers ?? undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
        redirect: "error",
      });

      const responseText = await response.text();
      let responseData: unknown;

      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      if (!response.ok) {
        return Err(
          createError(
            ErrorCode.CIRCUIT_OPEN,
            `API call failed with status ${response.status}: ${responseText.slice(0, 200)}`,
          ),
        );
      }

      return Ok({ data: responseData, tokensUsed: 0 });
    } catch (err: unknown) {
      if (signal.aborted) {
        return Err(createError(ErrorCode.TIMEOUT, "API call aborted"));
      }
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.CIRCUIT_OPEN, `API call failed: ${msg}`, err));
    }
  }
}
