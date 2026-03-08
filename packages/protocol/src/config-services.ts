/**
 * Service configuration schemas: HA, security, database, logging,
 * privacy, digest, telemetry, plugins, LLM, daemon.
 */

import { z } from "zod";
import { SecretRefSchema } from "./config-base.ts";

// ---------------------------------------------------------------------------
// Home Automation
// ---------------------------------------------------------------------------

export const HADomainPolicySchema = z.object({
  domain: z.string(),
  level: z.enum(["safe", "needs_approval", "dangerous"]),
  exceptions: z.record(z.string(), z.enum(["safe", "needs_approval", "dangerous"])).optional(),
});

export const HAAnomalyRuleSchema = z.object({
  /** Glob pattern matched against entity IDs (e.g. "light.*", "sensor.temperature_*"). Uses glob matching, NOT regex. */
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
  haUrl: z.string().max(2048).optional(),
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
  policies: z
    .object({
      shellExecution: z.enum(["safe", "needs_approval", "dangerous"]).default("needs_approval"),
      fileModification: z.enum(["safe", "needs_approval", "dangerous"]).default("needs_approval"),
      networkAccess: z.enum(["safe", "needs_approval", "dangerous"]).default("safe"),
      secretAccess: z.enum(["safe", "needs_approval", "dangerous"]).default("dangerous"),
    })
    .default({}),
  approval: z
    .object({
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
    })
    .default({}),
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
      runtime: z.enum(["none", "docker", "bubblewrap"]).default("none"),
    })
    .default({}),
  audit: z
    .object({
      enabled: z.boolean().default(true),
      retentionDays: z.number().int().positive().default(365),
    })
    .default({}),
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
  channel: z.enum(["telegram", "desktop", "slack", "all"]).default("telegram"),
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
// Telemetry (OpenTelemetry)
// ---------------------------------------------------------------------------

export const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().max(2048).default("http://localhost:4318"),
  protocol: z.enum(["grpc", "http"]).default("http"),
  serviceName: z.string().default("eidolon-core"),
  sampleRate: z.number().min(0).max(1).default(1.0),
  exportIntervalMs: z.number().int().positive().default(5000),
  attributes: z.record(z.string(), z.string()).default({}),
});

// ---------------------------------------------------------------------------
// Plugin System
// ---------------------------------------------------------------------------

export const PluginConfigSchema = z.object({
  enabled: z.boolean().default(false),
  directory: z.string().default(""),
  autoUpdate: z.boolean().default(false),
  allowedPermissions: z.array(z.string()).default(["events:listen", "events:emit", "config:read", "gateway:register"]),
  blockedPlugins: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Local LLM Providers
// ---------------------------------------------------------------------------

export const OllamaProviderSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().max(2048).default("http://localhost:11434"),
  defaultModel: z.string().default("llama3.2"),
  /** Allow connections to private/internal network addresses (localhost, 10.x, etc.). Defaults to true for backward compatibility since Ollama is typically a local service. */
  allowPrivateHosts: z.boolean().default(true),
  models: z
    .record(
      z.string(),
      z.object({
        contextLength: z.number().int().positive().default(8192),
        supportsTools: z.boolean().default(false),
      }),
    )
    .default({}),
});

export const LlamaCppProviderSchema = z.object({
  enabled: z.boolean().default(false),
  serverPath: z.string().default(""),
  modelPath: z.string().default(""),
  gpuLayers: z.number().int().min(0).default(0),
  contextLength: z.number().int().positive().default(8192),
  port: z.number().int().min(1).max(65535).default(8421),
});

export const LLMConfigSchema = z.object({
  providers: z
    .object({
      ollama: OllamaProviderSchema.optional(),
      llamacpp: LlamaCppProviderSchema.optional(),
    })
    .default({}),
  routing: z
    .record(
      z.enum(["conversation", "extraction", "filtering", "dreaming", "code-generation", "summarization", "embedding"]),
      z.array(z.enum(["claude", "ollama", "llamacpp"])),
    )
    .default({}),
});

// ---------------------------------------------------------------------------
// Browser Automation
// ---------------------------------------------------------------------------

export const BrowserConfigSchema = z.object({
  enabled: z.boolean().default(false),
  headless: z.boolean().default(true),
  profilePath: z.string().default(""), // resolved at runtime to platform default
  defaultTimeoutMs: z.number().int().positive().default(30_000),
  viewport: z
    .object({
      width: z.number().int().positive().default(1280),
      height: z.number().int().positive().default(720),
    })
    .default({}),
  maxTabs: z.number().int().positive().default(5),
});

// ---------------------------------------------------------------------------
// Users (Multi-User Support)
// ---------------------------------------------------------------------------

export const UsersConfigSchema = z
  .object({
    /** Enable multi-user mode. When false, all activity maps to "default" user. */
    multiUserEnabled: z.boolean().default(false),
    /** ID of the fallback user when no mapping is found. */
    defaultUser: z.string().default("default"),
    /** Auto-create users on first contact from an allowlisted channel ID. */
    autoCreateUsers: z.boolean().default(true),
  })
  .default({});

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export const DaemonConfigSchema = z.object({
  pidFile: z.string().default(""), // resolved at runtime
  gracefulShutdownMs: z.number().int().positive().default(10_000),
});

// ---------------------------------------------------------------------------
// Replication (Disaster Recovery)
// ---------------------------------------------------------------------------

export const ReplicationConfigSchema = z.object({
  /** Whether replication is enabled. */
  enabled: z.boolean().default(false),
  /** This node's initial role. */
  role: z.enum(["primary", "secondary"]).default("primary"),
  /** Tailscale or LAN address of the peer node (host:port). */
  peerAddress: z.string().max(253).default(""),
  /** Port this node listens on for replication protocol. */
  listenPort: z.number().int().min(1).max(65535).default(9820),
  /** Heartbeat interval in milliseconds. */
  heartbeatIntervalMs: z.number().int().positive().default(5_000),
  /** How many missed heartbeats before failover. */
  missedHeartbeatsThreshold: z.number().int().positive().default(3),
  /** Snapshot (full DB copy) interval in milliseconds. Default: 5 minutes. */
  snapshotIntervalMs: z.number().int().positive().default(300_000),
  /** Directory for storing received snapshots on the secondary. */
  snapshotDir: z.string().default(""),
  /** Shared secret for HMAC message authentication between nodes. Must match on both peers. */
  sharedSecret: z.string().default(""),
});
