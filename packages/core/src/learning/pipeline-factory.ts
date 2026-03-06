/**
 * Production factory functions for the ImplementationPipeline dependencies.
 *
 * Provides real implementations of ImplementFn and RunCommandFn
 * using Bun.spawn for git commands and shell execution.
 *
 * These are NOT used in tests -- tests inject mock functions instead.
 * This module provides the production wiring for daemon runtime.
 */

import type { EidolonError, IClaudeProcess, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { ImplementFn, RunCommandFn } from "./implementation.ts";

// ---------------------------------------------------------------------------
// RunCommandFn: real shell execution via Bun.spawn
// ---------------------------------------------------------------------------

/** Maximum command execution time (5 minutes). */
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/**
 * Create a production RunCommandFn that executes shell commands via Bun.spawn.
 *
 * Commands are run in a bash shell with a configurable timeout.
 * stdout and stderr are captured and returned.
 */
export function createRunCommandFn(logger: Logger, timeoutMs?: number): RunCommandFn {
  const timeout = timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const childLogger = logger.child("pipeline-cmd");

  return async (
    command: string,
    cwd: string,
  ): Promise<Result<{ stdout: string; exitCode: number }, EidolonError>> => {
    childLogger.debug("run", `Executing: ${command}`, { cwd });

    try {
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      // Read stdout and stderr
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();

      // Wait for completion with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
        }, timeout);
      });

      const exitCode = await Promise.race([proc.exited, timeoutPromise]);
      const stdout = await stdoutPromise;
      const stderr = await stderrPromise;

      const combinedOutput = stderr.length > 0 ? `${stdout}\n${stderr}`.trim() : stdout.trim();

      childLogger.debug("run", `Completed with exit code ${exitCode}`, {
        command,
        exitCode,
        outputLength: combinedOutput.length,
      });

      return Ok({ stdout: combinedOutput, exitCode });
    } catch (cause) {
      childLogger.error("run", `Command failed: ${command}`, cause);
      return Err(createError(ErrorCode.DISCOVERY_FAILED, `Command execution failed: ${command}`, cause));
    }
  };
}

// ---------------------------------------------------------------------------
// ImplementFn: real Claude Code session for implementation
// ---------------------------------------------------------------------------

/**
 * Create a production ImplementFn that uses IClaudeProcess to implement changes.
 *
 * Spawns a Claude Code session with restricted tools (learning session type)
 * and collects the response text.
 */
export function createImplementFn(claude: IClaudeProcess, logger: Logger): ImplementFn {
  const childLogger = logger.child("pipeline-impl");

  return async (prompt: string, workspaceDir: string): Promise<Result<string, EidolonError>> => {
    childLogger.info("implement", "Starting Claude Code implementation session", {
      workspaceDir,
      promptLength: prompt.length,
    });

    try {
      const chunks: string[] = [];

      for await (const event of claude.run(prompt, {
        workspaceDir,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
        maxTurns: 20,
        systemPrompt:
          "You are implementing a self-learning improvement for Eidolon. " +
          "Make minimal, focused changes. Run tests after changes. " +
          "Do not modify unrelated code. Document what you changed and why.",
      })) {
        if (event.type === "text" && event.content) {
          chunks.push(event.content);
        }
        if (event.type === "error" && event.error) {
          childLogger.warn("implement", `Claude error during implementation: ${event.error}`);
          return Err(
            createError(ErrorCode.CLAUDE_PROCESS_CRASHED, `Implementation failed: ${event.error}`),
          );
        }
      }

      const output = chunks.join("");
      childLogger.info("implement", "Implementation session completed", {
        outputLength: output.length,
      });

      return Ok(output);
    } catch (cause) {
      childLogger.error("implement", "Implementation session crashed", cause);
      return Err(
        createError(ErrorCode.CLAUDE_PROCESS_CRASHED, "Implementation session crashed", cause),
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Git worktree helpers
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for isolated implementation.
 *
 * Uses `git worktree add` to create a new worktree at the given path
 * on a new branch. Returns the worktree path on success.
 */
export async function createGitWorktree(
  runCommand: RunCommandFn,
  repoDir: string,
  branch: string,
  worktreePath: string,
  logger: Logger,
): Promise<Result<string, EidolonError>> {
  const childLogger = logger.child("git-worktree");

  // Validate branch name (same validation as ImplementationPipeline)
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

  childLogger.info("create", `Creating worktree: ${worktreePath} on branch ${branch}`);

  const result = await runCommand(
    `git worktree add -b ${branch} ${worktreePath}`,
    repoDir,
  );

  if (!result.ok) {
    return Err(result.error);
  }

  if (result.value.exitCode !== 0) {
    childLogger.warn("create", `Worktree creation failed: ${result.value.stdout}`);
    return Err(
      createError(ErrorCode.DISCOVERY_FAILED, `Failed to create git worktree: ${result.value.stdout}`),
    );
  }

  childLogger.info("create", `Worktree created at ${worktreePath}`);
  return Ok(worktreePath);
}

/**
 * Remove a git worktree after implementation is complete.
 */
export async function removeGitWorktree(
  runCommand: RunCommandFn,
  repoDir: string,
  worktreePath: string,
  logger: Logger,
): Promise<Result<void, EidolonError>> {
  const childLogger = logger.child("git-worktree");

  childLogger.info("remove", `Removing worktree: ${worktreePath}`);

  const result = await runCommand(
    `git worktree remove ${worktreePath} --force`,
    repoDir,
  );

  if (!result.ok) {
    childLogger.warn("remove", `Worktree removal failed: ${result.error.message}`);
    return Err(result.error);
  }

  if (result.value.exitCode !== 0) {
    childLogger.warn("remove", `Worktree removal returned non-zero: ${result.value.stdout}`);
    // Not a fatal error -- worktree might already be removed
  }

  return Ok(undefined);
}
