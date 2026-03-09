/**
 * GitAnalyzer -- read-only Git operations for project analysis.
 *
 * Parses git log, branches, and status using Bun.spawn().
 * All operations are read-only (never modifies the repo).
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { GitBranchInfo, GitCommit } from "./schema.ts";

const MAX_LOG_LIMIT = 500;
const DEFAULT_LOG_LIMIT = 50;
const GIT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a repo path is safe to use as a cwd for git operations.
 * Rejects paths containing ".." traversal and verifies the path is a directory.
 */
function validateRepoPath(repoPath: string): Result<string, EidolonError> {
  const resolved = resolve(repoPath);

  // Reject path traversal patterns in the original input
  if (repoPath.includes("..")) {
    return Err(createError(ErrorCode.SECURITY_BLOCKED, `Repo path contains traversal: ${repoPath}`));
  }

  // Verify the path exists and is a directory
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Repo path is not a directory: ${resolved}`));
    }
  } catch {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Repo path does not exist: ${resolved}`));
  }

  return Ok(resolved);
}

async function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<Result<string, EidolonError>> {
  const pathResult = validateRepoPath(cwd);
  if (!pathResult.ok) return pathResult;
  const validatedCwd = pathResult.value;

  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: validatedCwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
    }, timeoutMs);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    clearTimeout(timeoutId);

    if (exitCode !== 0) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `git ${args[0]} failed: ${stderr.trim()}`));
    }

    return Ok(stdout.trim());
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to run git ${args[0]}`, cause));
  }
}

function parseCommitLine(line: string): GitCommit | null {
  // Format: hash|shortHash|author|timestamp|message
  const parts = line.split("|");
  if (parts.length < 5) return null;

  const hash = parts[0] ?? "";
  const shortHash = parts[1] ?? "";
  const author = parts[2] ?? "";
  const timestamp = Number.parseInt(parts[3] ?? "0", 10);
  const message = parts.slice(4).join("|"); // message may contain |

  if (!hash || Number.isNaN(timestamp)) return null;

  return { hash, shortHash, author, date: timestamp * 1000, message };
}

// ---------------------------------------------------------------------------
// GitAnalyzer
// ---------------------------------------------------------------------------

export class GitAnalyzer {
  // biome-ignore lint/complexity/noUselessConstructor: logger reserved for future diagnostic use
  constructor(_logger: Logger) {}

  /** Verify that a path is a valid git repository. */
  async isGitRepo(repoPath: string): Promise<Result<boolean, EidolonError>> {
    if (!existsSync(repoPath)) {
      return Ok(false);
    }
    const result = await runGit(["rev-parse", "--is-inside-work-tree"], repoPath);
    if (!result.ok) return Ok(false);
    return Ok(result.value === "true");
  }

  /** Get the current branch name. */
  async getCurrentBranch(repoPath: string): Promise<Result<string, EidolonError>> {
    return runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  }

  /** List all local branches. */
  async getBranches(repoPath: string): Promise<Result<GitBranchInfo[], EidolonError>> {
    const result = await runGit(["branch", "--format=%(refname:short)|%(objectname:short)|%(HEAD)"], repoPath);
    if (!result.ok) return result;

    const branches: GitBranchInfo[] = [];
    for (const line of result.value.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length < 3) continue;
      branches.push({
        name: parts[0] ?? "",
        lastCommitHash: parts[1],
        isCurrent: (parts[2] ?? "").trim() === "*",
      });
    }

    return Ok(branches);
  }

  /** Get recent commits from git log. */
  async getCommits(repoPath: string, limit?: number, since?: number): Promise<Result<GitCommit[], EidolonError>> {
    const count = Math.max(1, Math.min(limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT));
    const args = ["log", `--max-count=${count}`, "--format=%H|%h|%an|%at|%s"];

    if (since !== undefined) {
      const sinceDate = new Date(since).toISOString();
      args.push(`--since=${sinceDate}`);
    }

    const result = await runGit(args, repoPath);
    if (!result.ok) return result;

    if (!result.value) return Ok([]);

    const commits: GitCommit[] = [];
    for (const line of result.value.split("\n")) {
      const commit = parseCommitLine(line);
      if (commit) commits.push(commit);
    }

    return Ok(commits);
  }

  /** Count uncommitted changes (staged + unstaged + untracked). */
  async getUncommittedCount(repoPath: string): Promise<Result<number, EidolonError>> {
    const result = await runGit(["status", "--porcelain"], repoPath);
    if (!result.ok) return result;
    if (!result.value) return Ok(0);
    return Ok(result.value.split("\n").filter((l) => l.trim().length > 0).length);
  }

  /** Get ahead/behind counts relative to the upstream tracking branch. */
  async getAheadBehind(repoPath: string): Promise<Result<{ ahead: number; behind: number } | null, EidolonError>> {
    const result = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], repoPath);
    if (!result.ok) return Ok(null); // no upstream configured

    const parts = result.value.split(/\s+/);
    if (parts.length < 2) return Ok(null);

    const ahead = Number.parseInt(parts[0] ?? "0", 10);
    const behind = Number.parseInt(parts[1] ?? "0", 10);

    if (Number.isNaN(ahead) || Number.isNaN(behind)) return Ok(null);
    return Ok({ ahead, behind });
  }

  /** Get file change statistics for commits in a date range. */
  async getFileStats(repoPath: string, since: number, until: number): Promise<Result<number, EidolonError>> {
    const sinceStr = new Date(since).toISOString();
    const untilStr = new Date(until).toISOString();

    const result = await runGit(
      ["log", `--since=${sinceStr}`, `--until=${untilStr}`, "--format=", "--numstat"],
      repoPath,
    );
    if (!result.ok) return result;
    if (!result.value) return Ok(0);

    // Count unique files changed
    const files = new Set<string>();
    for (const line of result.value.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        files.add(parts[2] ?? "");
      }
    }

    return Ok(files.size);
  }

  /**
   * Generate a plain-text summary of commits in a date range.
   * Groups commits by day and returns a readable summary.
   */
  generateCommitSummary(commits: readonly GitCommit[]): string {
    if (commits.length === 0) return "No commits in this period.";

    const byDay = new Map<string, GitCommit[]>();
    for (const commit of commits) {
      const day = new Date(commit.date).toISOString().slice(0, 10);
      const existing = byDay.get(day) ?? [];
      existing.push(commit);
      byDay.set(day, existing);
    }

    const lines: string[] = [];
    const sortedDays = [...byDay.keys()].sort().reverse();

    for (const day of sortedDays) {
      const dayCommits = byDay.get(day) ?? [];
      lines.push(`## ${day} (${dayCommits.length} commits)`);
      for (const c of dayCommits) {
        lines.push(`- ${c.message} (${c.author}, ${c.shortHash})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
