import { describe, expect, test } from "bun:test";
import {
  getMcpTemplate,
  listMcpTemplates,
  MCP_TEMPLATES,
  McpTemplateSchema,
  searchMcpTemplates,
  templateToConfigEntry,
} from "../templates.ts";

describe("MCP Templates", () => {
  test("all templates validate against the schema", () => {
    for (const [id, template] of Object.entries(MCP_TEMPLATES)) {
      const result = McpTemplateSchema.safeParse(template);
      expect(result.success).toBe(true);
      expect(template.id).toBe(id);
    }
  });

  test("catalog contains at least 10 templates", () => {
    const templates = listMcpTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(10);
  });

  test("getMcpTemplate returns a known template", () => {
    const github = getMcpTemplate("github");
    expect(github).toBeDefined();
    expect(github?.name).toBe("GitHub");
    expect(github?.requiredSecrets).toContain("GITHUB_TOKEN");
  });

  test("getMcpTemplate returns undefined for unknown id", () => {
    const result = getMcpTemplate("nonexistent-server-xyz");
    expect(result).toBeUndefined();
  });

  test("searchMcpTemplates finds by name", () => {
    const results = searchMcpTemplates("home assistant");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.id).toBe("home-assistant");
  });

  test("searchMcpTemplates finds by tag", () => {
    const results = searchMcpTemplates("database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("sqlite");
  });

  test("searchMcpTemplates is case-insensitive", () => {
    const results = searchMcpTemplates("GITHUB");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.id).toBe("github");
  });

  test("searchMcpTemplates returns empty for no match", () => {
    const results = searchMcpTemplates("zzz_no_match_zzz");
    expect(results).toHaveLength(0);
  });

  test("templateToConfigEntry produces valid config", () => {
    const github = getMcpTemplate("github");
    expect(github).toBeDefined();
    if (!github) return;

    const entry = templateToConfigEntry(github);
    expect(entry.command).toBe("npx");
    expect(entry.args).toContain("@modelcontextprotocol/server-github");
    expect(entry.env).toBeDefined();
    expect(entry.env?.GITHUB_TOKEN).toBe("$secret:GITHUB_TOKEN");
  });

  test("templateToConfigEntry handles templates without env", () => {
    const filesystem = getMcpTemplate("filesystem");
    expect(filesystem).toBeDefined();
    if (!filesystem) return;

    const entry = templateToConfigEntry(filesystem);
    expect(entry.command).toBe("npx");
    expect(entry.env).toBeUndefined();
  });

  test("each template has required fields", () => {
    for (const template of listMcpTemplates()) {
      expect(template.id).toBeTruthy();
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.command).toBeTruthy();
      expect(Array.isArray(template.args)).toBe(true);
      expect(Array.isArray(template.requiredSecrets)).toBe(true);
      expect(Array.isArray(template.tags)).toBe(true);
      expect(template.tags.length).toBeGreaterThan(0);
    }
  });
});
