/**
 * Implementation pipeline for self-learning discoveries.
 *
 * Takes an approved discovery and attempts to implement it autonomously
 * via injected functions (no real git/shell calls), making it fully testable.
 *
 * SAFETY RULE (ABSOLUTE): Code changes are NEVER classified as `safe`.
 * Always `needs_approval` at minimum. ALL code changes require user approval
 * before merge.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { randomUUID } from "crypto";
import type { Logger } from "../logging/logger.js";

/**
 * Escape < and > in untrusted text to prevent XML delimiter injection.
 * This ensures user-provided content cannot break out of XML-like prompt delimiters.
 */
function escapeXmlDelimiters(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Sanitize user-provided text for inclusion in Markdown (PR descriptions).
 * Escapes characters that could inject Markdown headings, links, or formatting.
 */
function sanitizeForMarkdown(text: string): string {
  return text.replace(/\n/g, " ").replace(/[#*\->`[\]\\|!()<>]/g, (ch) => `\\${ch}`);
}

export interface ImplementationStep {
  readonly name: string;
  readonly status: "pending" | "running" | "passed" | "failed" | "skipped";
  readonly output?: string;
  readonly durationMs?: number;
}

export interface ImplementationResult {
  readonly discoveryId: string;
  readonly branch: string;
  readonly success: boolean;
  readonly steps: readonly ImplementationStep[];
  readonly error?: string;
  readonly prDescription?: string;
}

/** Dependency: function that runs a Claude Code session to implement the change. */
export type ImplementFn = (prompt: string, workspaceDir: string) => Promise<Result<string, EidolonError>>;

/** Dependency: function that runs a shell command and returns output. */
export type RunCommandFn = (
  command: string,
  cwd: string,
) => Promise<Result<{ stdout: string; exitCode: number }, EidolonError>>;

export interface ImplementationRunOptions {
  readonly discoveryId: string;
  readonly title: string;
  readonly content: string;
  readonly workspaceDir: string;
  readonly implementFn: ImplementFn;
  readonly runCommandFn: RunCommandFn;
}

/** Maximum slug length in generated branch names. */
const MAX_SLUG_LENGTH = 50;

/**
 * Slugify a string: lowercase, replace non-alphanumeric with hyphens,
 * collapse consecutive hyphens, trim leading/trailing hyphens.
 */
function slugify(text: string, maxLength: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength);
}

export class ImplementationPipeline {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Run the full implementation pipeline for a discovery.
   *
   * Steps:
   * 1. Create git branch (learning/discovery-{id})
   * 2. Run Claude Code to implement the change (via implementFn)
   * 3. Run linter (pnpm -r lint)
   * 4. Run tests (pnpm -r test)
   * 5. If all pass: generate PR description
   * 6. If any fail: report failure
   *
   * NOTE: This method does NOT actually run git/shell commands.
   * It orchestrates via injected functions (implementFn, runCommandFn)
   * so it can be tested without real git/shell.
   */
  async run(options: ImplementationRunOptions): Promise<Result<ImplementationResult, EidolonError>> {
    const steps: ImplementationStep[] = [];
    const branch = ImplementationPipeline.generateBranchName(options.discoveryId, options.title);

    this.logger.info("learning", "Starting implementation pipeline", {
      discoveryId: options.discoveryId,
      branch,
    });

    // Validate branch name to prevent command injection.
    // Only allow alphanumeric, dots, hyphens, underscores, and forward slashes.
    // Reject names starting with '-' (git flag injection), containing '..', or consecutive slashes.
    // Also enforce a maximum length to prevent buffer-based attacks.
    const SAFE_BRANCH = /^[a-zA-Z0-9._/-]+$/;
    if (
      !SAFE_BRANCH.test(branch) ||
      branch.startsWith("-") ||
      branch.includes("..") ||
      branch.includes("//") ||
      branch.length > 200
    ) {
      return Err(createError(ErrorCode.DISCOVERY_FAILED, `Invalid branch name: ${branch}`));
    }

    // Step 1: Create branch
    const branchStart = Date.now();
    const branchResult = await options.runCommandFn(`git checkout -b ${branch}`, options.workspaceDir);
    const branchDuration = Date.now() - branchStart;

    if (!branchResult.ok || branchResult.value.exitCode !== 0) {
      const output = branchResult.ok ? branchResult.value.stdout : branchResult.error.message;
      steps.push({
        name: "create_branch",
        status: "failed",
        output,
        durationMs: branchDuration,
      });
      this.logger.warn("learning", "Branch creation failed", { branch, output });
      return Ok({
        discoveryId: options.discoveryId,
        branch,
        success: false,
        steps,
        error: "Failed to create branch",
      });
    }

    steps.push({
      name: "create_branch",
      status: "passed",
      output: branchResult.value.stdout,
      durationMs: branchDuration,
    });

    // Step 2: Implement via Claude Code
    // Use random boundaries and escape XML delimiters to mitigate prompt injection
    const implStart = Date.now();
    const boundary = `---BOUNDARY-${randomUUID()}---`;
    const safeTitle = escapeXmlDelimiters(options.title);
    const safeContent = escapeXmlDelimiters(options.content);
    const implementResult = await options.implementFn(
      `Implement this improvement:\n\n${boundary}\nTITLE: ${safeTitle}\n${boundary}\n\n${boundary}\nCONTENT: ${safeContent}\n${boundary}`,
      options.workspaceDir,
    );
    const implDuration = Date.now() - implStart;

    if (!implementResult.ok) {
      steps.push({
        name: "implement",
        status: "failed",
        output: implementResult.error.message,
        durationMs: implDuration,
      });
      this.logger.warn("learning", "Implementation failed", {
        discoveryId: options.discoveryId,
        error: implementResult.error.message,
      });
      return Ok({
        discoveryId: options.discoveryId,
        branch,
        success: false,
        steps,
        error: "Implementation failed",
      });
    }

    steps.push({
      name: "implement",
      status: "passed",
      output: implementResult.value,
      durationMs: implDuration,
    });

    // Step 3: Lint
    const lintStart = Date.now();
    const lintResult = await options.runCommandFn("pnpm -r lint", options.workspaceDir);
    const lintDuration = Date.now() - lintStart;

    steps.push({
      name: "lint",
      status: lintResult.ok && lintResult.value.exitCode === 0 ? "passed" : "failed",
      output: lintResult.ok ? lintResult.value.stdout : "Lint failed",
      durationMs: lintDuration,
    });

    // Step 4: Test
    const testStart = Date.now();
    const testResult = await options.runCommandFn("pnpm -r test", options.workspaceDir);
    const testDuration = Date.now() - testStart;

    steps.push({
      name: "test",
      status: testResult.ok && testResult.value.exitCode === 0 ? "passed" : "failed",
      output: testResult.ok ? testResult.value.stdout : "Tests failed",
      durationMs: testDuration,
    });

    const success = steps.every((s) => s.status === "passed");
    const prDescription = success
      ? ImplementationPipeline.generatePrDescription(options.title, options.content, steps)
      : undefined;

    this.logger.info("learning", "Implementation pipeline completed", {
      discoveryId: options.discoveryId,
      branch,
      success,
      stepCount: steps.length,
    });

    return Ok({
      discoveryId: options.discoveryId,
      branch,
      success,
      steps,
      prDescription,
    });
  }

  /**
   * Generate a branch name from a discovery ID and title.
   * Format: learning/{first8charsOfId}-{slug}
   * Slug is lowercase, max 50 chars.
   */
  static generateBranchName(discoveryId: string, title: string): string {
    const idPrefix = discoveryId.slice(0, 8);
    const slug = slugify(title, MAX_SLUG_LENGTH);
    return `learning/${idPrefix}-${slug}`;
  }

  /**
   * Generate a PR description from the implementation result.
   */
  static generatePrDescription(title: string, content: string, steps: readonly ImplementationStep[]): string {
    const lintStep = steps.find((s) => s.name === "lint");
    const testStep = steps.find((s) => s.name === "test");
    const lintCheck = lintStep?.status === "passed" ? "[x] Lint passed" : "[ ] Lint passed";
    const testCheck = testStep?.status === "passed" ? "[x] Tests passed" : "[ ] Tests passed";

    const safeTitle = sanitizeForMarkdown(title);
    const safeContent = sanitizeForMarkdown(content);

    return [
      "## Self-Learning Implementation",
      "",
      "### Discovery",
      safeTitle,
      "",
      "### What Changed",
      safeContent,
      "",
      "### Verification",
      `- ${lintCheck}`,
      `- ${testCheck}`,
      "",
      "### Source",
      "Automatically implemented by Eidolon's self-learning pipeline.",
      "Requires manual review and approval before merge.",
      "",
    ].join("\n");
  }
}
