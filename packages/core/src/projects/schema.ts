/**
 * Zod schemas and types for project management.
 *
 * Defines the Project entity, DB row mapping, and validation schemas
 * for creating/updating projects.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  repoPath: z.string().min(1).max(1000),
  description: z.string().max(2000).default(""),
  lastSyncedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const CreateProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  repoPath: z.string().min(1).max(1000),
  description: z.string().max(2000).optional(),
});

export const UpdateProjectInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  repoPath: z.string().min(1).max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Project = z.infer<typeof ProjectSchema>;
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

// ---------------------------------------------------------------------------
// DB Row Types
// ---------------------------------------------------------------------------

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly repo_path: string;
  readonly description: string;
  readonly last_synced_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    description: row.description,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Git Commit Types
// ---------------------------------------------------------------------------

export const GitCommitSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  author: z.string(),
  date: z.number(),
  message: z.string(),
});

export type GitCommit = z.infer<typeof GitCommitSchema>;

export const GitBranchInfoSchema = z.object({
  name: z.string(),
  isCurrent: z.boolean(),
  lastCommitHash: z.string().optional(),
});

export type GitBranchInfo = z.infer<typeof GitBranchInfoSchema>;

export const ProjectStatusSchema = z.object({
  project: ProjectSchema,
  currentBranch: z.string(),
  branches: z.array(GitBranchInfoSchema),
  recentCommits: z.array(GitCommitSchema),
  uncommittedChanges: z.number(),
  aheadBehind: z.object({
    ahead: z.number(),
    behind: z.number(),
  }).optional(),
});

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

// ---------------------------------------------------------------------------
// Journal Entry Types
// ---------------------------------------------------------------------------

export const ProjectJournalEntrySchema = z.object({
  id: z.string(),
  projectId: z.string().uuid(),
  period: z.enum(["daily", "weekly"]),
  periodStart: z.number(),
  periodEnd: z.number(),
  summary: z.string(),
  commitCount: z.number(),
  filesChanged: z.number(),
  createdAt: z.number(),
});

export type ProjectJournalEntry = z.infer<typeof ProjectJournalEntrySchema>;

export interface ProjectJournalRow {
  readonly id: string;
  readonly project_id: string;
  readonly period: string;
  readonly period_start: number;
  readonly period_end: number;
  readonly summary: string;
  readonly commit_count: number;
  readonly files_changed: number;
  readonly created_at: number;
}

export function rowToJournalEntry(row: ProjectJournalRow): ProjectJournalEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    period: row.period as "daily" | "weekly",
    periodStart: row.period_start,
    periodEnd: row.period_end,
    summary: row.summary,
    commitCount: row.commit_count,
    filesChanged: row.files_changed,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// DB Schema SQL
// ---------------------------------------------------------------------------

export const PROJECTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    repo_path TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    last_synced_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
`;

export const PROJECT_JOURNAL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS project_journal (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    period TEXT NOT NULL CHECK(period IN ('daily','weekly')),
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    summary TEXT NOT NULL,
    commit_count INTEGER NOT NULL DEFAULT 0,
    files_changed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_project_journal_project ON project_journal(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_journal_period ON project_journal(period_start, period_end);
`;
