/**
 * ProjectJournal -- automatic diary entries from git history.
 *
 * Generates daily and weekly journal entries for registered projects
 * by analyzing git commits in the relevant time period.
 * Stores entries in the project_journal table of operational.db.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { GitAnalyzer } from "./git-analyzer.ts";
import type { Project, ProjectJournalEntry, ProjectJournalRow } from "./schema.ts";
import { rowToJournalEntry } from "./schema.ts";

const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the start of a day (midnight UTC) for a timestamp. */
function startOfDayUtc(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Get the start of the ISO week (Monday) for a timestamp. */
function startOfWeekUtc(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay();
  // ISO week starts on Monday (1), Sunday is 0
  const diff = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// ProjectJournal
// ---------------------------------------------------------------------------

export class ProjectJournal {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly git: GitAnalyzer;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("project-journal");
    this.git = new GitAnalyzer(logger);
  }

  /** Generate a daily journal entry for a project. Skips if already exists. */
  async generateDaily(project: Project, date?: number): Promise<Result<ProjectJournalEntry | null, EidolonError>> {
    const dayStart = startOfDayUtc(date ?? Date.now());
    const dayEnd = dayStart + MS_PER_DAY;

    // Check if entry already exists
    const existing = this.getEntry(project.id, "daily", dayStart);
    if (!existing.ok) return existing;
    if (existing.value) return Ok(existing.value); // already generated

    // Get commits for this day
    const commitsResult = await this.git.getCommits(project.repoPath, 500, dayStart);
    if (!commitsResult.ok) return commitsResult;

    // Filter to only commits within the day
    const dayCommits = commitsResult.value.filter((c) => c.date >= dayStart && c.date < dayEnd);

    if (dayCommits.length === 0) return Ok(null); // nothing to report

    // Get file stats
    const filesResult = await this.git.getFileStats(project.repoPath, dayStart, dayEnd);
    const filesChanged = filesResult.ok ? filesResult.value : 0;

    // Generate summary
    const summary = this.git.generateCommitSummary(dayCommits);
    const dateStr = new Date(dayStart).toISOString().slice(0, 10);
    const fullSummary = `# ${project.name} - Daily Journal (${dateStr})\n\n${summary}`;

    return this.createEntry({
      projectId: project.id,
      period: "daily",
      periodStart: dayStart,
      periodEnd: dayEnd,
      summary: fullSummary,
      commitCount: dayCommits.length,
      filesChanged,
    });
  }

  /** Generate a weekly journal entry for a project. Skips if already exists. */
  async generateWeekly(project: Project, date?: number): Promise<Result<ProjectJournalEntry | null, EidolonError>> {
    const weekStart = startOfWeekUtc(date ?? Date.now());
    const weekEnd = weekStart + MS_PER_WEEK;

    // Check if entry already exists
    const existing = this.getEntry(project.id, "weekly", weekStart);
    if (!existing.ok) return existing;
    if (existing.value) return Ok(existing.value);

    // Get commits for this week
    const commitsResult = await this.git.getCommits(project.repoPath, 500, weekStart);
    if (!commitsResult.ok) return commitsResult;

    const weekCommits = commitsResult.value.filter((c) => c.date >= weekStart && c.date < weekEnd);

    if (weekCommits.length === 0) return Ok(null);

    const filesResult = await this.git.getFileStats(project.repoPath, weekStart, weekEnd);
    const filesChanged = filesResult.ok ? filesResult.value : 0;

    const summary = this.git.generateCommitSummary(weekCommits);
    const startStr = new Date(weekStart).toISOString().slice(0, 10);
    const endStr = new Date(weekEnd - 1).toISOString().slice(0, 10);
    const fullSummary = `# ${project.name} - Weekly Journal (${startStr} to ${endStr})\n\n${summary}`;

    return this.createEntry({
      projectId: project.id,
      period: "weekly",
      periodStart: weekStart,
      periodEnd: weekEnd,
      summary: fullSummary,
      commitCount: weekCommits.length,
      filesChanged,
    });
  }

  /** Get journal entries for a project, most recent first. */
  getEntries(
    projectId: string,
    options?: { period?: "daily" | "weekly"; limit?: number },
  ): Result<ProjectJournalEntry[], EidolonError> {
    try {
      const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
      let sql = "SELECT * FROM project_journal WHERE project_id = ?";
      const params: Array<string | number> = [projectId];

      if (options?.period) {
        sql += " AND period = ?";
        params.push(options.period);
      }

      sql += " ORDER BY period_start DESC LIMIT ?";
      params.push(limit);

      const rows = this.db.query(sql).all(...params) as ProjectJournalRow[];
      return Ok(rows.map(rowToJournalEntry));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get journal entries for ${projectId}`, cause));
    }
  }

  /** Get a specific journal entry by project, period type, and start date. */
  private getEntry(
    projectId: string,
    period: "daily" | "weekly",
    periodStart: number,
  ): Result<ProjectJournalEntry | null, EidolonError> {
    try {
      const row = this.db
        .query("SELECT * FROM project_journal WHERE project_id = ? AND period = ? AND period_start = ?")
        .get(projectId, period, periodStart) as ProjectJournalRow | null;
      return Ok(row ? rowToJournalEntry(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get journal entry", cause));
    }
  }

  /** Create a journal entry in the database. */
  private createEntry(input: {
    projectId: string;
    period: "daily" | "weekly";
    periodStart: number;
    periodEnd: number;
    summary: string;
    commitCount: number;
    filesChanged: number;
  }): Result<ProjectJournalEntry, EidolonError> {
    try {
      const id = randomUUID();
      const now = Date.now();

      this.db
        .query(
          `INSERT INTO project_journal
           (id, project_id, period, period_start, period_end, summary, commit_count, files_changed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.period,
          input.periodStart,
          input.periodEnd,
          input.summary,
          input.commitCount,
          input.filesChanged,
          now,
        );

      const entry: ProjectJournalEntry = {
        id,
        projectId: input.projectId,
        period: input.period,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        summary: input.summary,
        commitCount: input.commitCount,
        filesChanged: input.filesChanged,
        createdAt: now,
      };

      this.logger.info("create", `Journal entry created: ${input.period} for ${input.projectId}`, {
        entryId: id,
        commitCount: input.commitCount,
      });

      return Ok(entry);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create journal entry", cause));
    }
  }

  /** Sync all projects: generate daily entries for today and weekly if Monday. */
  async syncAll(projects: readonly Project[]): Promise<Result<number, EidolonError>> {
    let generated = 0;
    const now = Date.now();

    for (const project of projects) {
      // Daily
      const dailyResult = await this.generateDaily(project, now);
      if (dailyResult.ok && dailyResult.value) generated++;

      // Weekly: generate on Mondays (or if no weekly entry exists for this week)
      const dayOfWeek = new Date(now).getUTCDay();
      if (dayOfWeek === 1) {
        const weeklyResult = await this.generateWeekly(project, now);
        if (weeklyResult.ok && weeklyResult.value) generated++;
      }
    }

    this.logger.info("syncAll", `Generated ${generated} journal entries for ${projects.length} projects`);
    return Ok(generated);
  }
}
