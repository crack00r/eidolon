/**
 * ProjectManager -- CRUD operations for projects in operational.db.
 *
 * Manages project registration, updates, deletion, and status queries.
 * Works with GitAnalyzer for live repository status.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { GitAnalyzer } from "./git-analyzer.ts";
import type {
  CreateProjectInput,
  Project,
  ProjectRow,
  ProjectStatus,
  UpdateProjectInput,
} from "./schema.ts";
import {
  CreateProjectInputSchema,
  PROJECTS_TABLE_SQL,
  PROJECT_JOURNAL_TABLE_SQL,
  rowToProject,
  UpdateProjectInputSchema,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// ProjectManager
// ---------------------------------------------------------------------------

export class ProjectManager {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly git: GitAnalyzer;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("project-manager");
    this.git = new GitAnalyzer(logger);
  }

  /** Ensure the projects and project_journal tables exist. */
  ensureTables(): Result<void, EidolonError> {
    try {
      this.db.exec(PROJECTS_TABLE_SQL);
      this.db.exec(PROJECT_JOURNAL_TABLE_SQL);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create project tables", cause));
    }
  }

  /** Register a new project. Validates the repo path is a git repo. */
  async create(input: CreateProjectInput): Promise<Result<Project, EidolonError>> {
    const parsed = CreateProjectInputSchema.safeParse(input);
    if (!parsed.success) {
      return Err(
        createError(ErrorCode.CONFIG_INVALID, `Invalid project input: ${parsed.error.message}`),
      );
    }

    // Check that the path is a git repo
    const isRepo = await this.git.isGitRepo(parsed.data.repoPath);
    if (!isRepo.ok) return isRepo;
    if (!isRepo.value) {
      return Err(
        createError(ErrorCode.CONFIG_INVALID, `Path is not a git repository: ${parsed.data.repoPath}`),
      );
    }

    // Check for duplicate name
    try {
      const existing = this.db
        .query("SELECT id FROM projects WHERE name = ?")
        .get(parsed.data.name) as { id: string } | null;
      if (existing) {
        return Err(
          createError(ErrorCode.DB_QUERY_FAILED, `Project with name "${parsed.data.name}" already exists`),
        );
      }
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to check for duplicate project", cause));
    }

    try {
      const id = randomUUID();
      const now = Date.now();
      const description = parsed.data.description ?? "";

      this.db
        .query(
          `INSERT INTO projects (id, name, repo_path, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, parsed.data.name, parsed.data.repoPath, description, now, now);

      const project: Project = {
        id,
        name: parsed.data.name,
        repoPath: parsed.data.repoPath,
        description,
        lastSyncedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      this.logger.info("create", `Project registered: ${parsed.data.name}`, { projectId: id });
      return Ok(project);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create project: ${parsed.data.name}`, cause));
    }
  }

  /** Get a project by ID. */
  get(id: string): Result<Project | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null;
      return Ok(row ? rowToProject(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get project: ${id}`, cause));
    }
  }

  /** Get a project by name. */
  getByName(name: string): Result<Project | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRow | null;
      return Ok(row ? rowToProject(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get project by name: ${name}`, cause));
    }
  }

  /** List all projects. */
  list(): Result<Project[], EidolonError> {
    try {
      const rows = this.db.query("SELECT * FROM projects ORDER BY name ASC").all() as ProjectRow[];
      return Ok(rows.map(rowToProject));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list projects", cause));
    }
  }

  /** Update a project. */
  update(id: string, input: UpdateProjectInput): Result<Project, EidolonError> {
    const parsed = UpdateProjectInputSchema.safeParse(input);
    if (!parsed.success) {
      return Err(
        createError(ErrorCode.CONFIG_INVALID, `Invalid update input: ${parsed.error.message}`),
      );
    }

    try {
      const txn = this.db.transaction(() => {
        const existing = this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | null;
        if (!existing) return null;

        const now = Date.now();
        const setClauses: string[] = ["updated_at = ?"];
        const params: Array<string | number> = [now];

        if (parsed.data.name !== undefined) {
          setClauses.push("name = ?");
          params.push(parsed.data.name);
        }
        if (parsed.data.description !== undefined) {
          setClauses.push("description = ?");
          params.push(parsed.data.description);
        }
        if (parsed.data.repoPath !== undefined) {
          setClauses.push("repo_path = ?");
          params.push(parsed.data.repoPath);
        }

        params.push(id);
        this.db.query(`UPDATE projects SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

        return this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow;
      });

      const updated = txn();
      if (!updated) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Project not found: ${id}`));
      }
      this.logger.info("update", `Project updated: ${id}`);
      return Ok(rowToProject(updated));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update project: ${id}`, cause));
    }
  }

  /** Delete a project and its journal entries. */
  delete(id: string): Result<void, EidolonError> {
    try {
      const txn = this.db.transaction(() => {
        const existing = this.db.query("SELECT 1 FROM projects WHERE id = ?").get(id);
        if (!existing) return false;
        this.db.query("DELETE FROM project_journal WHERE project_id = ?").run(id);
        this.db.query("DELETE FROM projects WHERE id = ?").run(id);
        return true;
      });

      const deleted = txn();
      if (!deleted) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Project not found: ${id}`));
      }
      this.logger.info("delete", `Project deleted: ${id}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete project: ${id}`, cause));
    }
  }

  /** Get live status of a project by querying git. */
  async getStatus(id: string): Promise<Result<ProjectStatus, EidolonError>> {
    const projectResult = this.get(id);
    if (!projectResult.ok) return projectResult;
    if (!projectResult.value) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Project not found: ${id}`));
    }

    const project = projectResult.value;
    const repoPath = project.repoPath;

    const [branchResult, branchesResult, commitsResult, changesResult, aheadBehindResult] =
      await Promise.all([
        this.git.getCurrentBranch(repoPath),
        this.git.getBranches(repoPath),
        this.git.getCommits(repoPath, 10),
        this.git.getUncommittedCount(repoPath),
        this.git.getAheadBehind(repoPath),
      ]);

    const currentBranch = branchResult.ok ? branchResult.value : "unknown";
    const branches = branchesResult.ok ? branchesResult.value : [];
    const recentCommits = commitsResult.ok ? commitsResult.value : [];
    const uncommittedChanges = changesResult.ok ? changesResult.value : 0;
    const aheadBehind = aheadBehindResult.ok ? aheadBehindResult.value ?? undefined : undefined;

    return Ok({
      project,
      currentBranch,
      branches,
      recentCommits,
      uncommittedChanges,
      aheadBehind,
    });
  }

  /** Update the last_synced_at timestamp for a project. */
  markSynced(id: string): Result<void, EidolonError> {
    try {
      const now = Date.now();
      const changes = this.db
        .query("UPDATE projects SET last_synced_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, id);
      if (changes.changes === 0) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Project not found: ${id}`));
      }
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to mark project synced: ${id}`, cause));
    }
  }
}
