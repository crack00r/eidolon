import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TemplateVariables } from "../templates.ts";
import { findTemplatesDir, interpolateTemplate, loadWorkspaceTemplates } from "../templates.ts";

const TEST_TEMPLATES_DIR = join(import.meta.dir, ".tmp-templates-test");

const SAMPLE_VARIABLES: TemplateVariables = {
  ownerName: "Manuel",
  currentTime: "2026-03-06T12:00:00Z",
  channelId: "telegram",
  sessionType: "main",
};

describe("interpolateTemplate", () => {
  test("replaces known variables", () => {
    const template = "Hello {{ownerName}}, it is {{currentTime}}.";
    const result = interpolateTemplate(template, SAMPLE_VARIABLES);
    expect(result).toBe("Hello Manuel, it is 2026-03-06T12:00:00Z.");
  });

  test("leaves unknown variables untouched", () => {
    const template = "Hello {{ownerName}}, unknown is {{unknownVar}}.";
    const result = interpolateTemplate(template, SAMPLE_VARIABLES);
    expect(result).toBe("Hello Manuel, unknown is {{unknownVar}}.");
  });

  test("handles template with no variables", () => {
    const template = "No variables here.";
    const result = interpolateTemplate(template, SAMPLE_VARIABLES);
    expect(result).toBe("No variables here.");
  });

  test("handles multiple occurrences of the same variable", () => {
    const template = "{{ownerName}} said hello. {{ownerName}} left.";
    const result = interpolateTemplate(template, SAMPLE_VARIABLES);
    expect(result).toBe("Manuel said hello. Manuel left.");
  });

  test("handles empty template", () => {
    const result = interpolateTemplate("", SAMPLE_VARIABLES);
    expect(result).toBe("");
  });
});

describe("findTemplatesDir", () => {
  beforeEach(() => {
    mkdirSync(TEST_TEMPLATES_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_TEMPLATES_DIR)) {
      rmSync(TEST_TEMPLATES_DIR, { recursive: true });
    }
  });

  test("finds explicit directory when CLAUDE.md exists", async () => {
    await Bun.write(join(TEST_TEMPLATES_DIR, "CLAUDE.md"), "# Test");
    const result = findTemplatesDir(TEST_TEMPLATES_DIR);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain(".tmp-templates-test");
    }
  });

  test("returns error when CLAUDE.md is missing from explicit dir", () => {
    const result = findTemplatesDir(TEST_TEMPLATES_DIR);
    expect(result.ok).toBe(false);
  });

  test("walks upward to find workspace/ directory from repo", () => {
    // This test relies on the actual workspace/ directory we created at repo root
    const result = findTemplatesDir();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("workspace");
    }
  });
});

describe("loadWorkspaceTemplates", () => {
  beforeEach(() => {
    mkdirSync(TEST_TEMPLATES_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_TEMPLATES_DIR)) {
      rmSync(TEST_TEMPLATES_DIR, { recursive: true });
    }
  });

  test("loads and interpolates CLAUDE.md and SOUL.md", async () => {
    await Bun.write(join(TEST_TEMPLATES_DIR, "CLAUDE.md"), "Assistant for {{ownerName}}. Channel: {{channelId}}.");
    await Bun.write(join(TEST_TEMPLATES_DIR, "SOUL.md"), "You serve {{ownerName}} with care.");

    const result = await loadWorkspaceTemplates(SAMPLE_VARIABLES, TEST_TEMPLATES_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.claudeMd).toBe("Assistant for Manuel. Channel: telegram.");
    expect(result.value.soulMd).toBe("You serve Manuel with care.");
  });

  test("works when SOUL.md is missing", async () => {
    await Bun.write(join(TEST_TEMPLATES_DIR, "CLAUDE.md"), "Just CLAUDE for {{ownerName}}.");

    const result = await loadWorkspaceTemplates(SAMPLE_VARIABLES, TEST_TEMPLATES_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.claudeMd).toBe("Just CLAUDE for Manuel.");
    expect(result.value.soulMd).toBe("");
  });

  test("returns error when templates dir not found", async () => {
    const result = await loadWorkspaceTemplates(SAMPLE_VARIABLES, "/nonexistent/path/to/templates");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("loads real workspace templates from repo root", async () => {
    const result = await loadWorkspaceTemplates(SAMPLE_VARIABLES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify interpolation happened in CLAUDE.md
    expect(result.value.claudeMd).toContain("Manuel");
    expect(result.value.claudeMd).toContain("telegram");
    expect(result.value.claudeMd).toContain("main");
    expect(result.value.claudeMd).toContain("2026-03-06T12:00:00Z");

    // SOUL.md should be loaded (no dynamic variables expected)
    expect(result.value.soulMd).toContain("Eidolon");
    expect(result.value.soulMd).toContain("Personality");
  });
});
