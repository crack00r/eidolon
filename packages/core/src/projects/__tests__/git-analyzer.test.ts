import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../logging/logger.ts";
import { GitAnalyzer } from "../git-analyzer.ts";

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

describe("GitAnalyzer", () => {
  const logger = createSilentLogger();
  const analyzer = new GitAnalyzer(logger);

  // Use the eidolon repo itself as test target (read-only operations only)
  const eidolonRepoPath = join(import.meta.dir, "../../../../..");

  test("isGitRepo returns true for a valid git repo", async () => {
    const result = await analyzer.isGitRepo(eidolonRepoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  test("isGitRepo returns false for non-existent path", async () => {
    const result = await analyzer.isGitRepo("/nonexistent/path/12345");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false);
    }
  });

  test("isGitRepo returns false for a non-git directory", async () => {
    const result = await analyzer.isGitRepo(tmpdir());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false);
    }
  });

  test("getCurrentBranch returns a branch name", async () => {
    const result = await analyzer.getCurrentBranch(eidolonRepoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
    }
  });

  test("getBranches returns at least one branch", async () => {
    const result = await analyzer.getBranches(eidolonRepoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
      // At least one branch should be current
      const current = result.value.find((b) => b.isCurrent);
      expect(current).toBeDefined();
    }
  });

  test("getCommits returns commits with correct structure", async () => {
    const result = await analyzer.getCommits(eidolonRepoPath, 5);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value.length).toBeLessThanOrEqual(5);
      const commit = result.value[0];
      if (commit) {
        expect(commit.hash.length).toBeGreaterThan(0);
        expect(commit.shortHash.length).toBeGreaterThan(0);
        expect(commit.author.length).toBeGreaterThan(0);
        expect(commit.date).toBeGreaterThan(0);
        expect(commit.message.length).toBeGreaterThan(0);
      }
    }
  });

  test("getCommits respects limit", async () => {
    const result = await analyzer.getCommits(eidolonRepoPath, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeLessThanOrEqual(2);
    }
  });

  test("getUncommittedCount returns a number", async () => {
    const result = await analyzer.getUncommittedCount(eidolonRepoPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value).toBe("number");
      expect(result.value).toBeGreaterThanOrEqual(0);
    }
  });

  test("generateCommitSummary formats commits correctly", () => {
    const commits = [
      { hash: "aaa", shortHash: "aaa", author: "Alice", date: Date.now(), message: "fix: bug" },
      { hash: "bbb", shortHash: "bbb", author: "Bob", date: Date.now() - 86400000, message: "feat: feature" },
    ];
    const summary = analyzer.generateCommitSummary(commits);
    expect(summary).toContain("fix: bug");
    expect(summary).toContain("feat: feature");
    expect(summary).toContain("Alice");
    expect(summary).toContain("Bob");
  });

  test("generateCommitSummary handles empty commits", () => {
    const summary = analyzer.generateCommitSummary([]);
    expect(summary).toBe("No commits in this period.");
  });

  test("getAheadBehind returns null or counts", async () => {
    const result = await analyzer.getAheadBehind(eidolonRepoPath);
    expect(result.ok).toBe(true);
    if (result.ok && result.value !== null) {
      expect(typeof result.value.ahead).toBe("number");
      expect(typeof result.value.behind).toBe("number");
    }
  });
});
