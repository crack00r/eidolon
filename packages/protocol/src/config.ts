/**
 * Master configuration Zod schema for Eidolon.
 * Every configurable value has a sensible default.
 * Secret references use { "$secret": "KEY_NAME" } syntax.
 */

import { z } from "zod";
import { CalendarConfigSchema } from "./types/calendar.ts";

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
  /** IDs of MCP templates enabled for this instance (e.g. ["github", "home-assistant"]). */
  mcpTemplates: z.array(z.string()).default([]),
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
  obsidian: z
    .object({
      enabled: z.boolean().default(false),
      vaultPath: z.string().min(1),
      exclude: z.array(z.string()).default([".obsidian", ".trash"]),
      maxFileSize: z.number().int().positive().default(1_048_576),
    })
    .optional(),
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
  discord: z
    .object({
      enabled: z.boolean().default(false),
      botToken: SecretRefSchema.or(z.string()),
      allowedUserIds: z.array(z.string()),
      guildId: z.string().optional(),
      dmOnly: z.boolean().default(true),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export const WebhookEndpointSchema = z.object({
  /** URL path segment: /webhooks/{id} */
  id: z.string().min(1).max(100),
  /** Human-readable name for this webhook endpoint. */
  name: z.string().min(1).max(200),
  /** Auth token for this endpoint (Bearer or query param). */
  token: SecretRefSchema.or(z.string()),
  /** Event type to publish on the EventBus. */
  eventType: z.string().default("webhook:received"),
  /** Priority of the published event. */
  priority: z.enum(["critical", "high", "normal", "low"]).default("normal"),
  /** Whether this endpoint is active. */
  enabled: z.boolean().default(true),
});

export const GatewayConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(8419),
  tls: z
    .object({
      enabled: z.boolean().default(false),
      cert: z.string().optional(),
      key: z.string().optional(),
    })
    .refine((tls) => !tls.enabled || (tls.cert !== undefined && tls.key !== undefined), {
      message: "TLS cert and key are required when TLS is enabled",
    })
    .default({}),
  maxMessageBytes: z.number().int().positive().default(1_048_576),
  maxClients: z.number().int().positive().default(10),
  allowedOrigins: z.array(z.string()).default([]),
  rateLimiting: z
    .object({
      maxFailures: z.number().int().positive().default(5),
      windowMs: z.number().int().positive().default(60_000),
      blockMs: z.number().int().positive().default(300_000),
      maxBlockMs: z.number().int().positive().default(3_600_000),
    })
    .default({}),
  auth: z
    .object({
      type: z.enum(["token", "none"]).default("token"),
      token: SecretRefSchema.or(z.string()).optional(),
    })
    .refine((auth) => auth.type !== "token" || auth.token !== undefined, {
      message: "Token value is required when auth type is 'token'",
    }),
  webhooks: z
    .object({
      /** Configured webhook endpoints. */
      endpoints: z.array(WebhookEndpointSchema).default([]),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// GPU Workers
// ---------------------------------------------------------------------------

export const GpuWorkerSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int().positive().default(8420),
  token: SecretRefSchema.or(z.string()),
  capabilities: z.array(z.enum(["tts", "stt", "realtime"])).default(["tts", "stt"]),
  priority: z.number().int().min(1).max(100).default(50),
  maxConcurrent: z.number().int().positive().optional(),
});

export const GpuPoolSchema = z.object({
  loadBalancing: z.enum(["round-robin", "least-connections", "latency-weighted"]).default("least-connections"),
  healthCheckIntervalMs: z.number().int().positive().default(30_000),
  maxRetriesPerRequest: z.number().int().min(0).max(5).default(2),
});

export const GpuConfigSchema = z.object({
  workers: z.array(GpuWorkerSchema).default([]),
  pool: GpuPoolSchema.default({}),
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
// Home Automation
// ---------------------------------------------------------------------------

export const HADomainPolicySchema = z.object({
  domain: z.string(),
  level: z.enum(["safe", "needs_approval", "dangerous"]),
  exceptions: z.record(z.string(), z.enum(["safe", "needs_approval", "dangerous"])).optional(),
});

export const HAAnomalyRuleSchema = z.object({
  entityPattern: z.string(),
  condition: z.string(),
  message: z.string(),
});

export const HASceneActionConfigSchema = z.object({
  entityId: z.string(),
  service: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const HASceneConfigSchema = z.object({
  name: z.string(),
  actions: z.array(HASceneActionConfigSchema),
});

export const HomeAutomationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  haUrl: z.string().optional(),
  haToken: SecretRefSchema.or(z.string()).optional(),
  syncIntervalMinutes: z.number().int().positive().default(5),
  domainPolicies: z.array(HADomainPolicySchema).default([
    { domain: "light", level: "safe" as const },
    { domain: "switch", level: "safe" as const },
    { domain: "sensor", level: "safe" as const },
    { domain: "climate", level: "needs_approval" as const },
    { domain: "lock", level: "needs_approval" as const },
    { domain: "alarm_control_panel", level: "dangerous" as const },
    { domain: "cover", level: "safe" as const },
    { domain: "media_player", level: "safe" as const },
  ]),
  anomalyDetection: z
    .object({
      enabled: z.boolean().default(true),
      rules: z.array(HAAnomalyRuleSchema).default([]),
    })
    .default({}),
  scenes: z.array(HASceneConfigSchema).default([]),
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
    escalation: z
      .array(
        z.object({
          timeoutMs: z.number().int().positive(),
          action: z.enum(["deny", "approve", "escalate"]),
          escalateTo: z.string().optional(),
          maxEscalations: z.number().int().positive().default(3),
        }),
      )
      .default([]),
    /** How often to check for timed-out approval requests (ms). */
    checkIntervalMs: z.number().int().positive().default(10_000),
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
// Privacy & Retention
// ---------------------------------------------------------------------------

export const PrivacyConfigSchema = z.object({
  retention: z
    .object({
      conversationsDays: z.number().int().positive().default(365),
      eventsDays: z.number().int().positive().default(90),
      tokenUsageDays: z.number().int().positive().default(180),
      auditLogDays: z.literal(-1).or(z.number().int().positive()).default(-1), // -1 = NEVER delete (legal requirement)
    })
    .default({}),
  encryptBackups: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Digest (Daily Briefing)
// ---------------------------------------------------------------------------

export const DigestConfigSchema = z.object({
  enabled: z.boolean().default(false),
  time: z
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
  timezone: z.string().default("Europe/Berlin"),
  channel: z.enum(["telegram", "desktop", "all"]).default("telegram"),
  sections: z
    .object({
      conversations: z.boolean().default(true),
      learning: z.boolean().default(true),
      memory: z.boolean().default(true),
      schedule: z.boolean().default(true),
      metrics: z.boolean().default(true),
      actionItems: z.boolean().default(true),
    })
    .default({}),
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
  privacy: PrivacyConfigSchema.default({}),
  digest: DigestConfigSchema.default({}),
  calendar: CalendarConfigSchema.default({}),
  homeAutomation: HomeAutomationConfigSchema.default({}),
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
export type GpuWorkerConfigSchema = z.infer<typeof GpuWorkerSchema>;
export type GpuPoolConfig = z.infer<typeof GpuPoolSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type PrivacyConfig = z.infer<typeof PrivacyConfigSchema>;
export type DigestConfig = z.infer<typeof DigestConfigSchema>;
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type CalendarConfigInferred = z.infer<typeof CalendarConfigSchema>;
export type HomeAutomationConfig = z.infer<typeof HomeAutomationConfigSchema>;
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;
export type WebhookEndpointConfig = z.infer<typeof WebhookEndpointSchema>;
