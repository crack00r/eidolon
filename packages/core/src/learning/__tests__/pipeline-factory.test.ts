/**
 * Tests for pipeline-factory production implementations.
 *
 * Tests createRunCommandFn with real Bun.spawn, and createImplementFn
 * with FakeClaudeProcess.
 */

import { describe, expect, test } from "bun:test";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import type { Logger } from "../../logging/logger.ts";
import { createGitWorktree, createImplementFn, createRunCommandFn, removeGitWorktree } from "../pipeline-factory.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

const logger = createSilentLogger();

// ---------------------------------------------------------------------------
// createRunCommandFn
// ---------------------------------------------------------------------------

describe("createRunCommandFn", () => {
  test("executes a simple command successfully", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("echo hello", "/tmp");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitCode).toBe(0);
      expect(result.value.stdout).toContain("hello");
    }
  });

  test("returns non-zero exit code for failing commands", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("false", "/tmp");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitCode).not.toBe(0);
    }
  });

  test("captures stderr in output", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("echo error-msg >&2", "/tmp");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout).toContain("error-msg");
    }
  });

  test("respects cwd parameter", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("pwd", "/tmp");

    expect(result.ok).toBe(true);
    if (result.ok) {
      // On macOS, /tmp -> /private/tmp
      expect(result.value.stdout).toMatch(/\/tmp/);
    }
  });

  test("returns error for invalid cwd", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("echo test", "/nonexistent/path/that/does/not/exist");

    // Should return an Err since the cwd doesn't exist
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createImplementFn
// ---------------------------------------------------------------------------

describe("createImplementFn", () => {
  test("collects text from Claude Code session", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "Implementation complete: updated 3 files.");
    const implFn = createImplementFn(fake, logger);

    const result = await implFn("Implement caching", "/tmp/workspace");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("Implementation complete");
    }
  });

  test("passes correct options to Claude process", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "Done");
    const implFn = createImplementFn(fake, logger);

    await implFn("Test prompt", "/tmp/workspace");

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.workspaceDir).toBe("/tmp/workspace");
    expect(lastOptions?.allowedTools).toEqual(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
    expect(lastOptions?.maxTurns).toBe(20);
    expect(lastOptions?.systemPrompt).toContain("self-learning improvement");
  });

  test("sends the prompt to Claude", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "OK");
    const implFn = createImplementFn(fake, logger);

    await implFn("Implement error handling improvements", "/tmp/workspace");

    const lastPrompt = fake.getLastPrompt();
    expect(lastPrompt).toBe("Implement error handling improvements");
  });

  test("returns error on Claude process failure", async () => {
    const fake = FakeClaudeProcess.withError("CLAUDE_PROCESS_CRASHED", "Process crashed");
    const implFn = createImplementFn(fake, logger);

    const result = await implFn("Implement something", "/tmp/workspace");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CLAUDE_PROCESS_CRASHED");
    }
  });
});

// ---------------------------------------------------------------------------
// createGitWorktree / removeGitWorktree
// ---------------------------------------------------------------------------

describe("git worktree helpers", () => {
  test("createGitWorktree rejects invalid branch names", async () => {
    const runCommand = createRunCommandFn(logger);

    // Branch starting with dash (git flag injection)
    const result = await createGitWorktree(runCommand, "/tmp", "--delete", "/tmp/wt", logger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid branch name");
    }
  });

  test("createGitWorktree rejects branch names with ..", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await createGitWorktree(runCommand, "/tmp", "learning/../../../etc", "/tmp/wt", logger);
    expect(result.ok).toBe(false);
  });

  test("createGitWorktree rejects branch names with special characters", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await createGitWorktree(runCommand, "/tmp", "branch; rm -rf /", "/tmp/wt", logger);
    expect(result.ok).toBe(false);
  });

  test("createGitWorktree accepts valid branch names", async () => {
    // We don't actually run git here (no repo), but we verify it gets past validation
    // by checking that the command was attempted (which will fail because /tmp is not a git repo)
    const runCommand = createRunCommandFn(logger);

    const result = await createGitWorktree(runCommand, "/tmp", "learning/test-branch", "/tmp/wt-test", logger);
    // Will fail because /tmp is not a git repo, but the branch name validation passed
    // so we get a command execution error, not a validation error
    if (!result.ok) {
      expect(result.error.message).not.toContain("Invalid branch name");
    }
  });

  test("removeGitWorktree calls git worktree remove", async () => {
    let capturedCommand = "";
    const fakeRunCommand = async (cmd: string, _cwd: string) => {
      capturedCommand = cmd;
      return { ok: true as const, value: { stdout: "", exitCode: 0 } };
    };

    await removeGitWorktree(fakeRunCommand, "/repo", "/repo/worktrees/test", logger);

    expect(capturedCommand).toContain("git worktree remove");
    expect(capturedCommand).toContain("/repo/worktrees/test");
  });
});
