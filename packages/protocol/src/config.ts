/**
 * Master configuration Zod schema for Eidolon.
 * Every configurable value has a sensible default.
 * Secret references use { "$secret": "KEY_NAME" } syntax.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Secret Reference
// ---------------------------------------------------------------------------

export const SecretRefSchema = z.object({ $secret: z.string() });
export type SecretRef = z.infer<typeof SecretRefSchema>;

/** Accepts either a plain string or a { $secret: "KEY_NAME" } reference. */
export function stringOrSecret(): z.ZodUnion<[z.ZodString, typeof SecretRefSchema]> {
  return z.union([z.string(), SecretRefSchema]);
}

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
  model: z.object({
    default: z.string().default("claude-sonnet-4-20250514"),
    complex: z.string().default("claude-opus-4-20250514"),
    fast: z.string().default("claude-haiku-3-20250414"),
  }),
  session: z.object({
    maxTurns: z.number().int().positive().default(50),
    compactAfter: z.number().int().positive().default(40),
    timeoutMs: z.number().int().positive().default(300_000),
  }),
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
});

// ---------------------------------------------------------------------------
// Cognitive Loop
// ---------------------------------------------------------------------------

export const LoopConfigSchema = z.object({
  energyBudget: z.object({
    maxTokensPerHour: z.number().int().positive().default(100_000),
    categories: z.object({
      user: z.number().min(0).max(1).default(0.5),
      tasks: z.number().min(0).max(1).default(0.2),
      learning: z.number().min(0).max(1).default(0.2),
      dreaming: z.number().min(0).max(1).default(0.1),
    }),
  }),
  rest: z.object({
    activeMinMs: z.number().int().positive().default(2_000),
    idleMinMs: z.number().int().positive().default(30_000),
    maxMs: z.number().int().positive().default(300_000),
    nightModeStartHour: z.number().int().min(0).max(23).default(23),
    nightModeEndHour: z.number().int().min(0).max(23).default(7),
    nightModeMultiplier: z.number().min(1).max(10).default(3),
  }),
  businessHours: z.object({
    start: z.string().default("07:00"),
    end: z.string().default("23:00"),
    timezone: z.string().default("Europe/Berlin"),
  }),
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryConfigSchema = z.object({
  extraction: z.object({
    strategy: z.enum(["llm", "rule-based", "hybrid"]).default("hybrid"),
    minConfidence: z.number().min(0).max(1).default(0.7),
  }),
  dreaming: z.object({
    enabled: z.boolean().default(true),
    schedule: z.string().default("02:00"),
    maxDurationMinutes: z.number().int().positive().default(30),
  }),
  search: z.object({
    maxResults: z.number().int().positive().default(20),
    rrfK: z.number().int().positive().default(60),
    bm25Weight: z.number().min(0).max(1).default(0.4),
    vectorWeight: z.number().min(0).max(1).default(0.4),
    graphWeight: z.number().min(0).max(1).default(0.2),
  }),
  embedding: z.object({
    model: z.string().default("Xenova/multilingual-e5-small"),
    dimensions: z.number().int().positive().default(384),
    batchSize: z.number().int().positive().default(32),
  }),
  retention: z.object({
    shortTermDays: z.number().int().positive().default(90),
    decayRate: z.number().min(0).max(1).default(0.01),
  }),
  entityResolution: z.object({
    personThreshold: z.number().min(0).max(1).default(0.95),
    technologyThreshold: z.number().min(0).max(1).default(0.9),
    conceptThreshold: z.number().min(0).max(1).default(0.85),
  }),
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
        config: z.record(z.string(), z.unknown()),
        schedule: z.string().default("*/6 * * * *"),
      }),
    )
    .default([]),
  relevance: z.object({
    minScore: z.number().min(0).max(1).default(0.6),
    userInterests: z.array(z.string()).default([]),
  }),
  autoImplement: z.object({
    enabled: z.boolean().default(false),
    requireApproval: z.boolean().default(true),
    allowedScopes: z.array(z.string()).default([]),
  }),
  budget: z.object({
    maxTokensPerDay: z.number().int().positive().default(50_000),
    maxDiscoveriesPerDay: z.number().int().positive().default(20),
  }),
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const ChannelConfigSchema = z.object({
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      botToken: SecretRefSchema.or(z.string()),
      allowedUserIds: z.array(z.number().int()),
      notifyOnDiscovery: z.boolean().default(true),
      dndSchedule: z
        .object({
          start: z.string().default("22:00"),
          end: z.string().default("07:00"),
        })
        .optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export const GatewayConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().positive().default(8419),
  tls: z
    .object({
      enabled: z.boolean().default(false),
      cert: z.string().optional(),
      key: z.string().optional(),
    })
    .optional(),
  auth: z.object({
    type: z.enum(["token", "none"]).default("token"),
    token: SecretRefSchema.or(z.string()).optional(),
  }),
});

// ---------------------------------------------------------------------------
// GPU Workers
// ---------------------------------------------------------------------------

export const GpuConfigSchema = z.object({
  workers: z
    .array(
      z.object({
        name: z.string(),
        host: z.string(),
        port: z.number().int().positive().default(8420),
        token: SecretRefSchema.or(z.string()),
        capabilities: z.array(z.enum(["tts", "stt", "realtime"])).default(["tts", "stt"]),
      }),
    )
    .default([]),
  tts: z.object({
    model: z.string().default("Qwen/Qwen3-TTS-1.7B"),
    defaultSpeaker: z.string().default("Chelsie"),
    sampleRate: z.number().int().positive().default(24_000),
  }),
  stt: z.object({
    model: z.string().default("large-v3"),
    language: z.string().default("auto"),
  }),
  fallback: z.object({
    cpuTts: z.boolean().default(true),
    systemTts: z.boolean().default(true),
  }),
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export const SecurityConfigSchema = z.object({
  policies: z.object({
    shellExecution: z.enum(["safe", "needs_approval", "dangerous"]).default("needs_approval"),
    fileModification: z.enum(["safe", "needs_approval", "dangerous"]).default("needs_approval"),
    networkAccess: z.enum(["safe", "needs_approval", "dangerous"]).default("safe"),
    secretAccess: z.enum(["safe", "needs_approval", "dangerous"]).default("dangerous"),
  }),
  approval: z.object({
    timeout: z.number().int().positive().default(300_000),
    defaultAction: z.enum(["deny", "allow"]).default("deny"),
  }),
  sandbox: z.object({
    enabled: z.boolean().default(false),
    runtime: z.enum(["none", "docker", "bubblewrap"]).default("none"),
  }),
  audit: z.object({
    enabled: z.boolean().default(true),
    retentionDays: z.number().int().positive().default(365),
  }),
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export const DatabaseConfigSchema = z.object({
  directory: z.string().default(""), // resolved at runtime to platform default
  walMode: z.boolean().default(true),
  backupPath: z.string().optional(),
  backupSchedule: z.string().default("0 3 * * *"),
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
  directory: z.string().default(""), // resolved at runtime
  maxSizeMb: z.number().positive().default(50),
  maxFiles: z.number().int().positive().default(10),
});

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export const DaemonConfigSchema = z.object({
  pidFile: z.string().default(""), // resolved at runtime
  gracefulShutdownMs: z.number().int().positive().default(10_000),
});

// ---------------------------------------------------------------------------
// Master Config
// ---------------------------------------------------------------------------

export const EidolonConfigSchema = z.object({
  identity: z.object({
    name: z.string().default("Eidolon"),
    ownerName: z.string(),
  }),
  brain: BrainConfigSchema,
  loop: LoopConfigSchema,
  memory: MemoryConfigSchema,
  learning: LearningConfigSchema,
  channels: ChannelConfigSchema,
  gateway: GatewayConfigSchema,
  gpu: GpuConfigSchema,
  security: SecurityConfigSchema,
  database: DatabaseConfigSchema,
  logging: LoggingConfigSchema,
  daemon: DaemonConfigSchema,
});

// ---------------------------------------------------------------------------
// Inferred Types
// ---------------------------------------------------------------------------

export type EidolonConfig = z.infer<typeof EidolonConfigSchema>;
export type BrainConfig = z.infer<typeof BrainConfigSchema>;
export type LoopConfig = z.infer<typeof LoopConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type LearningConfig = z.infer<typeof LearningConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type GpuConfig = z.infer<typeof GpuConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;
