import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../logging/logger.ts";
import type { WorkspaceContent } from "../workspace.ts";
import { WorkspacePreparer } from "../workspace.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-workspace-test");
const logger = createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 10, maxFiles: 1 });

describe("WorkspacePreparer", () => {
  let preparer: WorkspacePreparer;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    preparer = new WorkspacePreparer(logger, TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("prepare() creates directory with CLAUDE.md", async () => {
    const content: WorkspaceContent = { claudeMd: "# Instructions\nBe helpful." };
    const result = await preparer.prepare("sess-1", content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(result.value)).toBe(true);
    expect(readFileSync(join(result.value, "CLAUDE.md"), "utf-8")).toBe("# Instructions\nBe helpful.");
  });

  test("prepare() creates SOUL.md when provided", async () => {
    const content: WorkspaceContent = { claudeMd: "# Instructions", soulMd: "# Soul\nBe kind." };
    const result = await preparer.prepare("sess-2", content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(result.value, "SOUL.md"), "utf-8")).toBe("# Soul\nBe kind.");
  });

  test("prepare() creates additional files", async () => {
    const content: WorkspaceContent = {
      claudeMd: "# Instructions",
      additionalFiles: { "context.txt": "some context", "data.json": '{"key":"value"}' },
    };
    const result = await preparer.prepare("sess-3", content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(result.value, "context.txt"), "utf-8")).toBe("some context");
    expect(readFileSync(join(result.value, "data.json"), "utf-8")).toBe('{"key":"value"}');
  });

  test("cleanup() removes workspace", async () => {
    const content: WorkspaceContent = { claudeMd: "# Test" };
    const result = await preparer.prepare("sess-4", content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(result.value)).toBe(true);
    preparer.cleanup("sess-4");
    expect(existsSync(result.value)).toBe(false);
  });

  test("cleanupOld() removes stale workspaces", async () => {
    const content: WorkspaceContent = { claudeMd: "# Old" };
    await preparer.prepare("old-sess", content);
    // maxAge of 0ms means everything is "old"
    const cleaned = preparer.cleanupOld(0);
    expect(cleaned).toBe(1);
    expect(existsSync(join(TEST_DIR, "old-sess"))).toBe(false);
  });
});
