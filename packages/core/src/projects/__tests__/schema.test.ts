import { describe, expect, test } from "bun:test";
import {
  CreateProjectInputSchema,
  GitCommitSchema,
  ProjectSchema,
  rowToJournalEntry,
  rowToProject,
  UpdateProjectInputSchema,
} from "../schema.ts";

describe("ProjectSchema", () => {
  test("validates a valid project", () => {
    const result = ProjectSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "eidolon",
      repoPath: "/home/user/projects/eidolon",
      description: "AI Assistant",
      lastSyncedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty name", () => {
    const result = CreateProjectInputSchema.safeParse({
      name: "",
      repoPath: "/some/path",
    });
    expect(result.success).toBe(false);
  });

  test("rejects name exceeding max length", () => {
    const result = CreateProjectInputSchema.safeParse({
      name: "a".repeat(201),
      repoPath: "/some/path",
    });
    expect(result.success).toBe(false);
  });

  test("allows optional description in create input", () => {
    const result = CreateProjectInputSchema.safeParse({
      name: "test-project",
      repoPath: "/some/path",
    });
    expect(result.success).toBe(true);
  });

  test("validates update input with partial fields", () => {
    const result = UpdateProjectInputSchema.safeParse({
      description: "Updated description",
    });
    expect(result.success).toBe(true);
  });
});

describe("GitCommitSchema", () => {
  test("validates a valid commit", () => {
    const result = GitCommitSchema.safeParse({
      hash: "abc123def456",
      shortHash: "abc123d",
      author: "Test User",
      date: Date.now(),
      message: "fix: something",
    });
    expect(result.success).toBe(true);
  });
});

describe("rowToProject", () => {
  test("maps DB row to Project type", () => {
    const now = Date.now();
    const project = rowToProject({
      id: "test-id",
      name: "test",
      repo_path: "/path/to/repo",
      description: "desc",
      last_synced_at: now,
      created_at: now,
      updated_at: now,
    });
    expect(project.id).toBe("test-id");
    expect(project.name).toBe("test");
    expect(project.repoPath).toBe("/path/to/repo");
    expect(project.lastSyncedAt).toBe(now);
  });

  test("handles null last_synced_at", () => {
    const project = rowToProject({
      id: "id",
      name: "n",
      repo_path: "/p",
      description: "",
      last_synced_at: null,
      created_at: 0,
      updated_at: 0,
    });
    expect(project.lastSyncedAt).toBeNull();
  });
});

describe("rowToJournalEntry", () => {
  test("maps DB row to ProjectJournalEntry type", () => {
    const entry = rowToJournalEntry({
      id: "entry-1",
      project_id: "proj-1",
      period: "daily",
      period_start: 1000,
      period_end: 2000,
      summary: "Some summary",
      commit_count: 5,
      files_changed: 10,
      created_at: 3000,
    });
    expect(entry.id).toBe("entry-1");
    expect(entry.projectId).toBe("proj-1");
    expect(entry.period).toBe("daily");
    expect(entry.commitCount).toBe(5);
    expect(entry.filesChanged).toBe(10);
  });
});
