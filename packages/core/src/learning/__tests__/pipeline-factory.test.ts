/**
 * Tests for pipeline-factory production implementations.
 *
 * Tests createRunCommandFn with real Bun.spawn, and createImplementFn
 * with FakeClaudeProcess.
 */

import { describe, expect, test } from "bun:test";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import type { Logger } from "../../logging/logger.ts";
import {
  createGitWorktree,
  createImplementFn,
  createRunCommandFn,
  removeGitWorktree,
  validateSafePath,
} from "../pipeline-factory.ts";

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
  test("executes a whitelisted git command successfully", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("git --version", "/tmp");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitCode).toBe(0);
      expect(result.value.stdout).toContain("git version");
    }
  });

  test("executes a whitelisted pnpm command successfully", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("pnpm --version", "/tmp");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exitCode).toBe(0);
    }
  });

  test("rejects non-whitelisted commands", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("echo hello", "/tmp");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not allowed");
    }
  });

  test("rejects commands attempting to bypass whitelist", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("rm -rf / && git status", "/tmp");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not allowed");
    }
  });

  test("respects cwd parameter", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("git rev-parse --show-toplevel", "/tmp");

    expect(result.ok).toBe(true);
    // The command may fail (not a git repo) but the function executed
  });

  test("returns error for invalid cwd", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await runCommand("git status", "/nonexistent/path/that/does/not/exist");

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
    expect(lastOptions?.allowedTools).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
    expect(lastOptions?.maxTurns).toBe(20);
    expect(lastOptions?.systemPrompt).toContain("self-learning improvement");
  });

  test("does not include Bash in allowedTools for security", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "Done");
    const implFn = createImplementFn(fake, logger);

    await implFn("Test prompt", "/tmp/workspace");

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.allowedTools).not.toContain("Bash");
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
// validateSafePath
// ---------------------------------------------------------------------------

describe("validateSafePath", () => {
  test("accepts valid absolute paths", () => {
    expect(() => validateSafePath("/tmp/worktree")).not.toThrow();
    expect(() => validateSafePath("/home/user/repo/wt-test")).not.toThrow();
    expect(() => validateSafePath("/var/lib/eidolon/worktrees/branch_1")).not.toThrow();
  });

  test("rejects empty path", () => {
    expect(() => validateSafePath("")).toThrow("must not be empty");
  });

  test("rejects paths with shell metacharacters", () => {
    expect(() => validateSafePath("/tmp/wt; rm -rf /")).toThrow("unsafe characters");
    expect(() => validateSafePath("/tmp/wt$(whoami)")).toThrow("unsafe characters");
    expect(() => validateSafePath("/tmp/wt`id`")).toThrow("unsafe characters");
    expect(() => validateSafePath("/tmp/wt | cat /etc/passwd")).toThrow("unsafe characters");
    expect(() => validateSafePath("/tmp/wt&bg")).toThrow("unsafe characters");
  });

  test("rejects paths with directory traversal", () => {
    expect(() => validateSafePath("/tmp/../etc/passwd")).toThrow("directory traversal");
  });

  test("rejects paths exceeding max length", () => {
    const longPath = "/" + "a".repeat(4096);
    expect(() => validateSafePath(longPath)).toThrow("too long");
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

  test("createGitWorktree rejects worktree paths with shell injection", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await createGitWorktree(runCommand, "/tmp", "valid-branch", "/tmp/wt; rm -rf /", logger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid worktree path");
    }
  });

  test("createGitWorktree rejects worktree paths with directory traversal", async () => {
    const runCommand = createRunCommandFn(logger);

    const result = await createGitWorktree(runCommand, "/tmp", "valid-branch", "/tmp/../etc/wt", logger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid worktree path");
    }
  });

  test("removeGitWorktree rejects unsafe worktree paths", async () => {
    const fakeRunCommand = async (_cmd: string, _cwd: string) => {
      return { ok: true as const, value: { stdout: "", exitCode: 0 } };
    };

    const result = await removeGitWorktree(fakeRunCommand, "/repo", "/tmp/wt$(whoami)", logger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid worktree path");
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
