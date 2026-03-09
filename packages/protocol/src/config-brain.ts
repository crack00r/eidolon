/**
 * Brain, cognitive loop, and memory configuration schemas.
 */

import { z } from "zod";
import { stringOrSecret } from "./config-base.ts";

// ---------------------------------------------------------------------------
// Claude Accounts
// ---------------------------------------------------------------------------

export const ClaudeAccountSchema = z.object({
  type: z.enum(["oauth", "api-key"]),
  name: z.string(),
  credential: stringOrSecret(),
  priority: z.number().int().min(1).max(100).default(50),
  maxTokensPerHour: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

export const BrainConfigSchema = z.object({
  accounts: z.array(ClaudeAccountSchema).min(1),
  model: z
    .object({
      default: z.string().default("claude-sonnet-4-20250514"),
      complex: z.string().default("claude-opus-4-20250514"),
      fast: z.string().default("claude-haiku-3-20250414"),
    })
    .default({}),
  session: z
    .object({
      maxTurns: z.number().int().positive().default(50),
      compactAfter: z.number().int().positive().default(40),
      timeoutMs: z.number().int().positive().default(300_000),
    })
    .default({}),
  mcpServers: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  /** IDs of MCP templates enabled for this instance (e.g. ["github", "home-assistant"]). */
  mcpTemplates: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Cognitive Loop
// ---------------------------------------------------------------------------

export const LoopConfigSchema = z.object({
  energyBudget: z
    .object({
      maxTokensPerHour: z.number().int().positive().default(100_000),
      categories: z
        .object({
          user: z.number().min(0).max(1).default(0.5),
          tasks: z.number().min(0).max(1).default(0.2),
          learning: z.number().min(0).max(1).default(0.2),
          dreaming: z.number().min(0).max(1).default(0.1),
        })
        .refine((c) => Math.abs(c.user + c.tasks + c.learning + c.dreaming - 1.0) <= 0.01, {
          message: "Energy budget categories must sum to 1.0 (within 0.01 tolerance)",
        })
        .default({}),
    })
    .default({}),
  rest: z
    .object({
      activeMinMs: z.number().int().positive().default(2_000),
      idleMinMs: z.number().int().positive().default(30_000),
      maxMs: z.number().int().positive().default(300_000),
      nightModeStartHour: z.number().int().min(0).max(23).default(23),
      nightModeEndHour: z.number().int().min(0).max(23).default(7),
      nightModeMultiplier: z.number().min(1).max(10).default(3),
    })
    .default({}),
  businessHours: z
    .object({
      start: z
        .string()
        .regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format")
        .refine(
          (v) => {
            const parts = v.split(":").map(Number);
            const h = parts[0] ?? -1;
            const m = parts[1] ?? -1;
            return h >= 0 && h <= 23 && m >= 0 && m <= 59;
          },
          { message: "Invalid time: hours must be 00-23, minutes must be 00-59" },
        )
        .default("07:00"),
      end: z
        .string()
        .regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format")
        .refine(
          (v) => {
            const parts = v.split(":").map(Number);
            const h = parts[0] ?? -1;
            const m = parts[1] ?? -1;
            return h >= 0 && h <= 23 && m >= 0 && m <= 59;
          },
          { message: "Invalid time: hours must be 00-23, minutes must be 00-59" },
        )
        .default("23:00"),
      timezone: z.string().default("Europe/Berlin"),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryConfigSchema = z.object({
  extraction: z
    .object({
      strategy: z.enum(["llm", "rule-based", "hybrid"]).default("hybrid"),
      minConfidence: z.number().min(0).max(1).default(0.7),
    })
    .default({}),
  consolidation: z
    .object({
      /** Whether consolidation is enabled. When false, all extractions are ADD. */
      enabled: z.boolean().default(true),
      /** Cosine similarity threshold above which a memory is considered a duplicate (NOOP). */
      duplicateThreshold: z.number().min(0).max(1).default(0.95),
      /** Cosine similarity threshold above which a memory is considered an update candidate. */
      updateThreshold: z.number().min(0).max(1).default(0.85),
      /** Maximum number of existing memories to compare against for each extraction. */
      maxCandidates: z.number().int().positive().default(10),
      /** Compression strategy for memory clusters. */
      compressionStrategy: z.enum(["none", "progressive", "hierarchical"]).default("none"),
      /** For progressive compression: compress when a topic cluster exceeds this count. */
      compressionThreshold: z.number().int().positive().default(10),
    })
    .default({}),
  dreaming: z
    .object({
      enabled: z.boolean().default(true),
      schedule: z.string().default("02:00"),
      maxDurationMinutes: z.number().int().positive().default(30),
    })
    .default({}),
  search: z
    .object({
      maxResults: z.number().int().positive().default(20),
      rrfK: z.number().int().positive().default(60),
      bm25Weight: z.number().min(0).max(1).default(0.4),
      vectorWeight: z.number().min(0).max(1).default(0.4),
      graphWeight: z.number().min(0).max(1).default(0.2),
    })
    .refine((s) => Math.abs(s.bm25Weight + s.vectorWeight + s.graphWeight - 1.0) <= 0.01, {
      message: "Search weights (bm25Weight + vectorWeight + graphWeight) must sum to 1.0 (within 0.01 tolerance)",
    })
    .default({}),
  embedding: z
    .object({
      model: z.string().default("Xenova/multilingual-e5-small"),
      dimensions: z.number().int().positive().default(384),
      batchSize: z.number().int().positive().default(32),
    })
    .default({}),
  retention: z
    .object({
      shortTermDays: z.number().int().positive().default(90),
      decayRate: z.number().min(0).max(1).default(0.01),
    })
    .default({}),
  entityResolution: z
    .object({
      personThreshold: z.number().min(0).max(1).default(0.95),
      technologyThreshold: z.number().min(0).max(1).default(0.9),
      conceptThreshold: z.number().min(0).max(1).default(0.85),
    })
    .default({}),
  obsidian: z
    .object({
      enabled: z.boolean().default(false),
      vaultPath: z.string().min(1),
      exclude: z.array(z.string()).default([".obsidian", ".trash"]),
      maxFileSize: z.number().int().positive().default(1_048_576),
    })
    .optional(),
  indexing: z
    .object({
      /** Whether document indexing is enabled. */
      enabled: z.boolean().default(false),
      /** Directory paths to index (absolute or relative to data dir). */
      paths: z.array(z.string()).default([]),
      /** File extensions to index. */
      fileTypes: z.array(z.string()).default([".md", ".txt", ".pdf", ".ts", ".py", ".js"]),
      /** Directory names to exclude from scanning. */
      exclude: z.array(z.string()).default(["node_modules", ".git", "dist"]),
      /** Maximum file size in bytes. Files exceeding this are skipped. */
      maxFileSize: z.number().int().positive().default(1_048_576),
      /** Re-check interval in seconds for changed files. */
      recheckIntervalSeconds: z.number().int().positive().default(3600),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export const LearningConfigSchema = z.object({
  enabled: z.boolean().default(false),
  sources: z
    .array(
      z.object({
        type: z.enum(["reddit", "hackernews", "github", "rss", "arxiv"]),
        config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        schedule: z
          .string()
          .regex(
            /^([*0-9,-]+(?:\/[0-9]+)?)(\s+[*0-9,-]+(?:\/[0-9]+)?){4}$/,
            "Must be a valid cron expression with 5 fields (e.g. '*/6 * * * *')",
          )
          .default("*/6 * * * *"),
      }),
    )
    .default([]),
  relevance: z
    .object({
      minScore: z.number().min(0).max(1).default(0.6),
      userInterests: z.array(z.string()).default([]),
    })
    .default({}),
  autoImplement: z
    .object({
      enabled: z.boolean().default(false),
      requireApproval: z.boolean().default(true),
      allowedScopes: z.array(z.string()).default([]),
    })
    .default({}),
  budget: z
    .object({
      maxTokensPerDay: z.number().int().positive().default(50_000),
      maxDiscoveriesPerDay: z.number().int().positive().default(20),
    })
    .default({}),
});
