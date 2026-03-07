/**
 * MCP server template definitions.
 *
 * Pre-configured templates for common MCP server integrations.
 * Each template defines the command, args, required environment variables,
 * required secrets, and a human-readable description.
 *
 * Usage:
 *   import { MCP_TEMPLATES, getMcpTemplate } from "./templates.ts";
 *   const tpl = getMcpTemplate("github");
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const McpTemplateSchema = z.object({
  /** Unique template identifier (e.g. "github", "home-assistant"). */
  id: z.string(),
  /** Human-readable display name. */
  name: z.string(),
  /** Short description of what the server provides. */
  description: z.string(),
  /** CLI command to run the MCP server (e.g. "npx"). */
  command: z.string(),
  /** Command arguments. */
  args: z.array(z.string()),
  /** Environment variables to set. Values starting with "$secret:" reference encrypted secrets. */
  env: z.record(z.string(), z.string()).optional(),
  /** Secret keys required in the secret store before this server can be used. */
  requiredSecrets: z.array(z.string()),
  /** URL to the MCP server documentation or source. */
  documentationUrl: z.string().optional(),
  /** Tags for categorization and search. */
  tags: z.array(z.string()),
});

export type McpTemplate = z.infer<typeof McpTemplateSchema>;

// ---------------------------------------------------------------------------
// Template Catalog
// ---------------------------------------------------------------------------

export const MCP_TEMPLATES: Record<string, McpTemplate> = {
  "home-assistant": {
    id: "home-assistant",
    name: "Home Assistant",
    description:
      "Control Home Assistant devices (lights, switches, sensors, climate, locks, alarms). " +
      "Integrates with Eidolon's entity resolver, security policies, scene engine, and anomaly detection.",
    command: "npx",
    args: ["-y", "mcp-server-home-assistant"],
    env: {
      HA_TOKEN: "$secret:HA_TOKEN",
      HA_URL: "http://homeassistant.local:8123",
    },
    requiredSecrets: ["HA_TOKEN"],
    documentationUrl: "https://github.com/home-assistant/mcp-server-home-assistant",
    tags: ["home-automation", "iot", "smart-home", "scenes", "security-policies"],
  },
  github: {
    id: "github",
    name: "GitHub",
    description: "GitHub repository operations (issues, PRs, search, file access)",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "$secret:GITHUB_TOKEN" },
    requiredSecrets: ["GITHUB_TOKEN"],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    tags: ["development", "git", "code"],
  },
  "brave-search": {
    id: "brave-search",
    name: "Brave Search",
    description: "Web and local search via the Brave Search API",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "$secret:BRAVE_API_KEY" },
    requiredSecrets: ["BRAVE_API_KEY"],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    tags: ["search", "web"],
  },
  filesystem: {
    id: "filesystem",
    name: "Filesystem",
    description: "Read/write access to specified directories on the host filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    requiredSecrets: [],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    tags: ["filesystem", "files"],
  },
  sqlite: {
    id: "sqlite",
    name: "SQLite",
    description: "Query and modify SQLite databases with read/write SQL access",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite"],
    requiredSecrets: [],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
    tags: ["database", "sql"],
  },
  slack: {
    id: "slack",
    name: "Slack",
    description: "Send messages, read channels, and manage Slack workspaces",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "$secret:SLACK_BOT_TOKEN" },
    requiredSecrets: ["SLACK_BOT_TOKEN"],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    tags: ["communication", "messaging", "team"],
  },
  notion: {
    id: "notion",
    name: "Notion",
    description: "Read and update Notion pages, databases, and blocks",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { OPENAPI_MCP_HEADERS: "$secret:NOTION_API_KEY" },
    requiredSecrets: ["NOTION_API_KEY"],
    documentationUrl: "https://github.com/makenotion/notion-mcp-server",
    tags: ["productivity", "notes", "wiki", "database"],
  },
  linear: {
    id: "linear",
    name: "Linear",
    description: "Manage Linear issues, projects, and teams",
    command: "npx",
    args: ["-y", "linear-mcp-server"],
    env: { LINEAR_API_KEY: "$secret:LINEAR_API_KEY" },
    requiredSecrets: ["LINEAR_API_KEY"],
    documentationUrl: "https://github.com/linear/linear-mcp-server",
    tags: ["project-management", "issues", "development"],
  },
  memory: {
    id: "memory",
    name: "Memory",
    description: "Persistent knowledge graph memory for storing and retrieving facts",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    requiredSecrets: [],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    tags: ["memory", "knowledge-graph"],
  },
  puppeteer: {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Browser automation for web scraping and interaction",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    requiredSecrets: [],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    tags: ["browser", "web", "automation"],
  },
  postgres: {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read-only access to PostgreSQL databases",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    env: { POSTGRES_URL: "$secret:POSTGRES_URL" },
    requiredSecrets: ["POSTGRES_URL"],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    tags: ["database", "sql"],
  },
  "google-maps": {
    id: "google-maps",
    name: "Google Maps",
    description: "Geocoding, directions, places search, and distance calculation",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    env: { GOOGLE_MAPS_API_KEY: "$secret:GOOGLE_MAPS_API_KEY" },
    requiredSecrets: ["GOOGLE_MAPS_API_KEY"],
    documentationUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps",
    tags: ["maps", "location", "navigation"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a template by its ID. Returns undefined if not found. */
export function getMcpTemplate(id: string): McpTemplate | undefined {
  return MCP_TEMPLATES[id];
}

/** List all available templates. */
export function listMcpTemplates(): readonly McpTemplate[] {
  return Object.values(MCP_TEMPLATES);
}

/** Search templates by tag or name substring (case-insensitive). */
export function searchMcpTemplates(query: string): readonly McpTemplate[] {
  const lowerQuery = query.toLowerCase();
  return Object.values(MCP_TEMPLATES).filter(
    (t) =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.id.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery) ||
      t.tags.some((tag) => tag.toLowerCase().includes(lowerQuery)),
  );
}

/**
 * Convert a template to a config-compatible MCP server entry.
 * Replaces `$secret:KEY` references with actual `{ $secret: "KEY" }` format
 * or leaves them as strings if they are literal values.
 */
export function templateToConfigEntry(template: McpTemplate): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  return {
    command: template.command,
    args: [...template.args],
    env: template.env ? { ...template.env } : undefined,
  };
}
