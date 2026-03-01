# Implementation Plan -- Master Blueprint

> **Status: Binding implementation contract. Every session MUST follow this plan.**
> Created 2026-03-01. Referenced from CLAUDE.md and MEMORY.md.
> This document defines the EXACT file structure, interfaces, dependencies, and build order.
> Deviations require explicit user approval.

---

## Table of Contents

1. [Package Architecture](#1-package-architecture)
2. [Dependency Graph](#2-dependency-graph)
3. [Shared Types -- packages/protocol](#3-shared-types----packagesprotocol)
4. [Phase 0: Foundation](#4-phase-0-foundation)
5. [Phase 1: Brain](#5-phase-1-brain)
6. [Phase 2: Memory](#6-phase-2-memory)
7. [Phase 3: Cognitive Loop](#7-phase-3-cognitive-loop)
8. [Phase 4: Telegram](#8-phase-4-telegram)
9. [Phase 4.5: Home Automation](#9-phase-45-home-automation)
10. [Phase 5: Self-Learning](#10-phase-5-self-learning)
11. [Phase 6: Voice](#11-phase-6-voice)
12. [Phase 7: Desktop Client](#12-phase-7-desktop-client)
13. [Phase 8: iOS Client](#13-phase-8-ios-client)
14. [Phase 9: Polish & Release](#14-phase-9-polish--release)
15. [Database Schemas](#15-database-schemas)
16. [Cross-Cutting Patterns](#16-cross-cutting-patterns)
17. [Complete File Index](#17-complete-file-index)

---

## 1. Package Architecture

Four TypeScript packages form the core system. Each is a pnpm workspace member.

```
packages/
  protocol/     # Layer 0 -- ZERO runtime deps. Pure types, Zod schemas, constants.
  core/         # Layer 1 -- THE BRAIN. All business logic. Depends on protocol.
  cli/          # Layer 2 -- CLI commands. Depends on core + protocol.
  test-utils/   # Layer T -- Test helpers. Depends on protocol only.
```

Later phases add:

```
apps/
  desktop/      # Layer 3 -- Tauri 2.0 + Svelte. Connects to core via WebSocket.
  ios/          # Layer 3 -- Swift/SwiftUI. Connects to core via WebSocket.
  web/          # Layer 3 -- Web dashboard. Post v1.0.
services/
  gpu-worker/   # Layer S -- Python/FastAPI. Connects to core via HTTP/WebSocket.
```

### Package Metadata

| Package | Name | Version | Entry Point | Build |
|---|---|---|---|---|
| `packages/protocol` | `@eidolon/protocol` | `0.0.0` | `src/index.ts` | `bun build` (types only, no bundling needed) |
| `packages/core` | `@eidolon/core` | `0.0.0` | `src/index.ts` | `bun build` |
| `packages/cli` | `@eidolon/cli` | `0.0.0` | `src/index.ts` | `bun build --target=bun --outfile=dist/eidolon` |
| `packages/test-utils` | `@eidolon/test-utils` | `0.0.0` | `src/index.ts` | `bun build` |

---

## 2. Dependency Graph

```
                    ┌─────────────┐
                    │  protocol   │  Layer 0 (no deps)
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐    │    ┌───────▼───────┐
       │    core      │    │    │  test-utils   │  Layer T
       │  (protocol)  │    │    │  (protocol)   │
       └──────┬───────┘    │    └───────────────┘
              │            │
       ┌──────▼──────┐    │
       │     cli      │    │
       │ (core, proto)│    │
       └─────────────┘    │
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
┌───▼────┐          ┌──────▼──────┐         ┌─────▼─────┐
│desktop │          │   ios       │         │gpu-worker │
│(WebSocket)        │(WebSocket)  │         │(HTTP/WS)  │
└────────┘          └─────────────┘         └───────────┘
```

### Import Rules (ENFORCED)

| From → To | Allowed? | How |
|---|---|---|
| protocol → (anything) | NO | protocol has ZERO internal deps |
| core → protocol | YES | `import { ... } from "@eidolon/protocol"` |
| core → cli | NO | core never imports cli |
| cli → core | YES | `import { ... } from "@eidolon/core"` |
| cli → protocol | YES | `import { ... } from "@eidolon/protocol"` |
| test-utils → protocol | YES | `import { ... } from "@eidolon/protocol"` |
| test-utils → core | NO | test-utils only knows protocol interfaces |
| desktop → protocol | YES | WebSocket message types |
| desktop → core | NO | communicates only via WebSocket |

---

## 3. Shared Types -- packages/protocol

This is the foundation. Every interface used across package boundaries lives here.
**Nothing else may define cross-package types.**

### 3.1 File Structure

```
packages/protocol/
  package.json
  tsconfig.json
  src/
    index.ts                    # barrel re-export of everything
    result.ts                   # Result type + helpers
    config.ts                   # EidolonConfig Zod schema (THE config schema)
    errors.ts                   # Error types and error codes
    constants.ts                # Shared constants
    types/
      events.ts                 # EventBus event types
      messages.ts               # InboundMessage, OutboundMessage
      sessions.ts               # Session types
      memory.ts                 # Memory types
      claude.ts                 # IClaudeProcess, StreamEvent
      channels.ts               # Channel interface
      voice.ts                  # Voice types
      database.ts               # Database schema types
      logging.ts                # Log entry types
      security.ts               # Action classification, audit
      learning.ts               # Discovery types
      gateway.ts                # WebSocket protocol types
      metrics.ts                # Token/cost tracking types
      scheduling.ts             # Scheduler types
      health.ts                 # Health check, circuit breaker types
```

### 3.2 Core Type Definitions

#### `result.ts` -- Result Pattern

```typescript
// Result type -- used for ALL expected failures across the project.
// Throw only for programming bugs; return Result for expected errors.

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function Ok<T>(value: T): Result<T, never>;
export function Err<E>(error: E): Result<never, E>;
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T };
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E };
export function unwrap<T, E>(result: Result<T, E>): T; // throws if Err
export function mapResult<T, U, E>(result: Result<T, E>, fn: (v: T) => U): Result<U, E>;
```

**Used by:** every module in core, cli, and test-utils.

#### `errors.ts` -- Error Types

```typescript
export const ErrorCode = {
  // Config
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_PARSE_ERROR: "CONFIG_PARSE_ERROR",
  // Secrets
  SECRET_NOT_FOUND: "SECRET_NOT_FOUND",
  SECRET_DECRYPTION_FAILED: "SECRET_DECRYPTION_FAILED",
  MASTER_KEY_MISSING: "MASTER_KEY_MISSING",
  // Database
  DB_CONNECTION_FAILED: "DB_CONNECTION_FAILED",
  DB_MIGRATION_FAILED: "DB_MIGRATION_FAILED",
  DB_QUERY_FAILED: "DB_QUERY_FAILED",
  // Claude
  CLAUDE_NOT_INSTALLED: "CLAUDE_NOT_INSTALLED",
  CLAUDE_AUTH_FAILED: "CLAUDE_AUTH_FAILED",
  CLAUDE_RATE_LIMITED: "CLAUDE_RATE_LIMITED",
  CLAUDE_PROCESS_CRASHED: "CLAUDE_PROCESS_CRASHED",
  CLAUDE_TIMEOUT: "CLAUDE_TIMEOUT",
  // Sessions
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_LIMIT_REACHED: "SESSION_LIMIT_REACHED",
  // Memory
  MEMORY_EXTRACTION_FAILED: "MEMORY_EXTRACTION_FAILED",
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
  // Channel
  CHANNEL_AUTH_FAILED: "CHANNEL_AUTH_FAILED",
  CHANNEL_SEND_FAILED: "CHANNEL_SEND_FAILED",
  // Gateway
  GATEWAY_AUTH_FAILED: "GATEWAY_AUTH_FAILED",
  // GPU
  GPU_UNAVAILABLE: "GPU_UNAVAILABLE",
  GPU_AUTH_FAILED: "GPU_AUTH_FAILED",
  TTS_FAILED: "TTS_FAILED",
  STT_FAILED: "STT_FAILED",
  // Learning
  DISCOVERY_FAILED: "DISCOVERY_FAILED",
  // General
  TIMEOUT: "TIMEOUT",
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface EidolonError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly timestamp: number;
}

export function createError(code: ErrorCode, message: string, cause?: unknown): EidolonError;
```

#### `config.ts` -- EidolonConfig (Zod Schema)

```typescript
import { z } from "zod";

// Secret reference: { "$secret": "KEY_NAME" } in config
export const SecretRefSchema = z.object({ $secret: z.string() });
export type SecretRef = z.infer<typeof SecretRefSchema>;

// Helper: value or secret reference
export function stringOrSecret(): z.ZodUnion<...>;

export const ClaudeAccountSchema = z.object({
  type: z.enum(["oauth", "api-key"]),
  name: z.string(),
  credential: stringOrSecret(),
  priority: z.number().int().min(1).max(100).default(50),
  maxTokensPerHour: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

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
  mcpServers: z.record(z.string(), z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
});

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
    technologyThreshold: z.number().min(0).max(1).default(0.90),
    conceptThreshold: z.number().min(0).max(1).default(0.85),
  }),
});

export const LearningConfigSchema = z.object({
  enabled: z.boolean().default(false),
  sources: z.array(z.object({
    type: z.enum(["reddit", "hackernews", "github", "rss", "arxiv"]),
    config: z.record(z.string(), z.unknown()),
    schedule: z.string().default("*/6 * * * *"),
  })).default([]),
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

export const ChannelConfigSchema = z.object({
  telegram: z.object({
    enabled: z.boolean().default(false),
    botToken: SecretRefSchema.or(z.string()),
    allowedUserIds: z.array(z.number().int()),
    notifyOnDiscovery: z.boolean().default(true),
    dndSchedule: z.object({
      start: z.string().default("22:00"),
      end: z.string().default("07:00"),
    }).optional(),
  }).optional(),
});

export const GatewayConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().positive().default(8419),
  tls: z.object({
    enabled: z.boolean().default(false),
    cert: z.string().optional(),
    key: z.string().optional(),
  }).optional(),
  auth: z.object({
    type: z.enum(["token", "none"]).default("token"),
    token: SecretRefSchema.or(z.string()).optional(),
  }),
});

export const GpuConfigSchema = z.object({
  workers: z.array(z.object({
    name: z.string(),
    host: z.string(),
    port: z.number().int().positive().default(8420),
    token: SecretRefSchema.or(z.string()),
    capabilities: z.array(z.enum(["tts", "stt", "realtime"])).default(["tts", "stt"]),
  })).default([]),
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

export const DatabaseConfigSchema = z.object({
  directory: z.string().default(""), // resolved at runtime to platform default
  walMode: z.boolean().default(true),
  backupPath: z.string().optional(),
  backupSchedule: z.string().default("0 3 * * *"),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
  directory: z.string().default(""), // resolved at runtime
  maxSizeMb: z.number().positive().default(50),
  maxFiles: z.number().int().positive().default(10),
});

export const DaemonConfigSchema = z.object({
  pidFile: z.string().default(""), // resolved at runtime
  gracefulShutdownMs: z.number().int().positive().default(10_000),
});

// THE master config schema
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
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;
```

**Used by:** `core/config/loader.ts`, `core/config/validator.ts`, `cli/commands/config.ts`, tests.

#### `types/claude.ts` -- Claude Code Integration

```typescript
// IClaudeProcess -- THE abstraction for Claude Code CLI.
// Production: ClaudeCodeManager implements this.
// Tests: FakeClaudeProcess implements this.

export interface StreamEvent {
  readonly type: "text" | "tool_use" | "tool_result" | "error" | "done" | "system";
  readonly content?: string;
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly toolResult?: unknown;
  readonly error?: string;
  readonly timestamp: number;
}

export interface ClaudeSessionOptions {
  readonly sessionId?: string;         // --session-id (resume existing)
  readonly workspaceDir: string;       // --project (workspace directory)
  readonly model?: string;             // --model
  readonly allowedTools?: string[];    // --allowedTools (tool whitelist)
  readonly mcpConfig?: string;         // --mcp-config (MCP server config path)
  readonly maxTurns?: number;          // --max-turns
  readonly systemPrompt?: string;      // --system-prompt (appended)
  readonly timeoutMs?: number;         // process-level timeout
  readonly env?: Record<string, string>; // environment variables (API keys go here)
}

export interface IClaudeProcess {
  // Start a Claude Code session and stream events
  run(prompt: string, options: ClaudeSessionOptions): AsyncIterable<StreamEvent>;

  // Check if Claude Code CLI is installed and accessible
  isAvailable(): Promise<boolean>;

  // Get Claude Code CLI version
  getVersion(): Promise<Result<string, EidolonError>>;

  // Abort a running session
  abort(sessionId: string): Promise<void>;
}

export type SessionType = "main" | "task" | "learning" | "dream" | "voice" | "review";

export interface SessionInfo {
  readonly id: string;
  readonly type: SessionType;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly tokensUsed: number;
  readonly status: "running" | "paused" | "completed" | "failed";
  readonly claudeSessionId?: string; // Claude Code's internal session ID
}
```

**Used by:** `core/claude/manager.ts`, `core/claude/session.ts`, `test-utils/fake-claude-process.ts`.

#### `types/events.ts` -- Event Bus

```typescript
export type EventPriority = "critical" | "high" | "normal" | "low";

export type EventType =
  // User events
  | "user:message"
  | "user:voice"
  | "user:approval"
  // System events
  | "system:startup"
  | "system:shutdown"
  | "system:health_check"
  | "system:config_changed"
  // Memory events
  | "memory:extracted"
  | "memory:dream_start"
  | "memory:dream_complete"
  // Learning events
  | "learning:discovery"
  | "learning:approved"
  | "learning:rejected"
  | "learning:implemented"
  // Session events
  | "session:started"
  | "session:completed"
  | "session:failed"
  | "session:budget_warning"
  // Channel events
  | "channel:connected"
  | "channel:disconnected"
  | "channel:error"
  // Scheduler events
  | "scheduler:task_due"
  // Gateway events
  | "gateway:client_connected"
  | "gateway:client_disconnected";

export interface BusEvent<T = unknown> {
  readonly id: string;          // UUID
  readonly type: EventType;
  readonly priority: EventPriority;
  readonly payload: T;
  readonly timestamp: number;
  readonly source: string;      // which module emitted this
  readonly processedAt?: number; // set when handled
}

// Typed payloads for specific events
export interface UserMessagePayload {
  readonly channelId: string;
  readonly userId: string;
  readonly text: string;
  readonly attachments?: Array<{ type: string; url: string }>;
}

export interface MemoryExtractedPayload {
  readonly sessionId: string;
  readonly memoryIds: string[];
  readonly count: number;
}

export interface DiscoveryPayload {
  readonly discoveryId: string;
  readonly source: string;
  readonly title: string;
  readonly relevanceScore: number;
}

export interface SessionEventPayload {
  readonly sessionId: string;
  readonly sessionType: SessionType;
  readonly reason?: string;
}
```

**Used by:** `core/loop/event-bus.ts`, `core/loop/cognitive-loop.ts`, `core/channels/`.

#### `types/messages.ts` -- Channel Messages

```typescript
export interface InboundMessage {
  readonly id: string;
  readonly channelId: string;       // "telegram", "desktop", "cli"
  readonly userId: string;
  readonly text?: string;
  readonly attachments?: MessageAttachment[];
  readonly replyToId?: string;
  readonly timestamp: number;
}

export interface OutboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly text: string;
  readonly format?: "text" | "markdown" | "html";
  readonly replyToId?: string;
  readonly attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  readonly type: "image" | "document" | "audio" | "voice" | "video";
  readonly url?: string;
  readonly data?: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
  readonly size?: number;
}
```

**Used by:** `core/channels/`, `core/loop/cognitive-loop.ts`.

#### `types/memory.ts` -- Memory System

```typescript
export type MemoryType =
  | "fact"          // discrete pieces of knowledge
  | "preference"    // user preferences
  | "decision"      // decisions made
  | "episode"       // interaction summaries
  | "skill"         // learned procedures
  | "relationship"  // connections between entities
  | "schema";       // abstract rules from NREM dreaming

export type MemoryLayer = "working" | "short_term" | "long_term" | "episodic" | "procedural";

export interface Memory {
  readonly id: string;
  readonly type: MemoryType;
  readonly layer: MemoryLayer;
  readonly content: string;
  readonly confidence: number;          // 0.0 - 1.0
  readonly source: string;              // "conversation:session_xyz", "dreaming:rem", etc.
  readonly tags: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly accessedAt: number;
  readonly accessCount: number;
  readonly embedding?: Float32Array;    // 384-dim vector
  readonly metadata?: Record<string, unknown>;
}

export interface MemoryEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relation: string;           // "related_to", "contradicts", "supports", "supersedes"
  readonly weight: number;             // 0.0 - 1.0
  readonly createdAt: number;
}

export interface MemorySearchQuery {
  readonly text: string;
  readonly limit?: number;
  readonly types?: MemoryType[];
  readonly layers?: MemoryLayer[];
  readonly minConfidence?: number;
  readonly tags?: string[];
  readonly includeGraph?: boolean;      // expand via graph edges
}

export interface MemorySearchResult {
  readonly memory: Memory;
  readonly score: number;               // combined RRF score
  readonly bm25Score?: number;
  readonly vectorScore?: number;
  readonly graphScore?: number;
  readonly matchReason: string;
}

// Knowledge Graph types
export interface KGEntity {
  readonly id: string;
  readonly name: string;
  readonly type: string;               // "person", "technology", "concept", "place", "org"
  readonly attributes: Record<string, unknown>;
  readonly embedding?: Float32Array;
  readonly createdAt: number;
}

export interface KGRelation {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;               // "knows", "uses", "works_at", "located_in", etc.
  readonly confidence: number;
  readonly source: string;
  readonly createdAt: number;
}

export interface KGCommunity {
  readonly id: string;
  readonly name: string;
  readonly entityIds: string[];
  readonly summary: string;
  readonly createdAt: number;
}

// Dreaming types
export interface DreamingResult {
  readonly phase: "housekeeping" | "rem" | "nrem";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly memoriesProcessed: number;
  readonly memoriesCreated: number;
  readonly memoriesRemoved: number;
  readonly edgesCreated: number;
  readonly tokensUsed: number;
}
```

**Used by:** `core/memory/` (all files), `core/loop/cognitive-loop.ts`, `cli/commands/memory.ts`.

#### `types/channels.ts` -- Channel Interface

```typescript
export interface ChannelCapabilities {
  readonly text: boolean;
  readonly markdown: boolean;
  readonly images: boolean;
  readonly documents: boolean;
  readonly voice: boolean;
  readonly reactions: boolean;
  readonly editing: boolean;
  readonly streaming: boolean;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ChannelCapabilities;

  connect(): Promise<Result<void, EidolonError>>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<Result<void, EidolonError>>;
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;
  isConnected(): boolean;
}
```

**Used by:** `core/channels/telegram.ts`, `core/channels/router.ts`.

#### `types/security.ts` -- Action Classification & Audit

```typescript
export type ActionLevel = "safe" | "needs_approval" | "dangerous";

export interface ActionClassification {
  readonly action: string;
  readonly level: ActionLevel;
  readonly reason: string;
  readonly requiresApproval: boolean;
}

export interface AuditEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly actor: string;              // "system", "user", "learning", session ID
  readonly action: string;
  readonly target: string;
  readonly result: "success" | "failure" | "denied";
  readonly metadata?: Record<string, unknown>;
}

export interface SecretMetadata {
  readonly key: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly accessedAt: number;
  readonly description?: string;
}
```

**Used by:** `core/security/`, `core/secrets/`, `cli/commands/secrets.ts`.

#### `types/gateway.ts` -- WebSocket Protocol

```typescript
// JSON-RPC 2.0 over WebSocket for client communication

export interface GatewayRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface GatewayResponse {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

export interface GatewayPushEvent {
  readonly jsonrpc: "2.0";
  readonly method: string;             // "message", "status", "memory", etc.
  readonly params: Record<string, unknown>;
}

// Specific RPC methods
export type GatewayMethod =
  | "chat.send"
  | "chat.stream"
  | "memory.search"
  | "memory.delete"
  | "session.list"
  | "session.info"
  | "learning.list"
  | "learning.approve"
  | "learning.reject"
  | "system.status"
  | "system.health"
  | "voice.start"
  | "voice.stop";

export interface ClientAuth {
  readonly type: "token";
  readonly token: string;
}
```

**Used by:** `core/gateway/`, `apps/desktop/`.

#### `types/health.ts` -- Health & Circuit Breakers

```typescript
export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  readonly name: string;
  readonly failureThreshold: number;   // failures before opening
  readonly resetTimeoutMs: number;     // time before half-open probe
  readonly halfOpenMaxAttempts: number; // probes before closing
}

export interface CircuitBreakerStatus {
  readonly name: string;
  readonly state: CircuitState;
  readonly failures: number;
  readonly lastFailureAt?: number;
  readonly lastSuccessAt?: number;
  readonly nextProbeAt?: number;
}

export interface HealthStatus {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly timestamp: number;
  readonly uptime: number;
  readonly checks: HealthCheck[];
}

export interface HealthCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly message?: string;
  readonly duration?: number;
}
```

**Used by:** `core/health/`, `core/loop/`, `cli/commands/doctor.ts`.

#### `types/metrics.ts` -- Token & Cost Tracking

```typescript
export interface TokenUsage {
  readonly sessionId: string;
  readonly sessionType: SessionType;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly timestamp: number;
}

export interface CostSummary {
  readonly period: "hour" | "day" | "week" | "month";
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly bySessionType: Record<SessionType, number>;
  readonly byModel: Record<string, number>;
}

// Model pricing table (cents per 1M tokens)
export interface ModelPricing {
  readonly model: string;
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cacheReadPer1M: number;
  readonly cacheWritePer1M: number;
}
```

**Used by:** `core/metrics/`, `core/loop/energy-budget.ts`, `cli/commands/daemon.ts`.

#### `types/logging.ts` -- Structured Logging

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly level: LogLevel;
  readonly timestamp: number;
  readonly module: string;             // "core:config", "core:memory", etc.
  readonly message: string;
  readonly data?: Record<string, unknown>;
  readonly error?: { message: string; stack?: string; code?: string };
  readonly traceId?: string;           // correlate related log entries
}
```

**Used by:** `core/logging/logger.ts`, every module in core.

#### `types/scheduling.ts` -- Scheduler

```typescript
export type ScheduleType = "once" | "recurring" | "conditional";

export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly type: ScheduleType;
  readonly cron?: string;              // for recurring (cron expression)
  readonly runAt?: number;             // for once (timestamp)
  readonly condition?: string;         // for conditional (evaluated expression)
  readonly action: string;             // event type to emit
  readonly payload: Record<string, unknown>;
  readonly enabled: boolean;
  readonly lastRunAt?: number;
  readonly nextRunAt?: number;
  readonly createdAt: number;
}
```

**Used by:** `core/scheduler/scheduler.ts`, `core/loop/cognitive-loop.ts`.

#### `types/learning.ts` -- Self-Learning

```typescript
export type DiscoverySourceType = "reddit" | "hackernews" | "github" | "rss" | "arxiv";
export type SafetyLevel = "safe" | "needs_approval" | "dangerous";

export interface Discovery {
  readonly id: string;
  readonly sourceType: DiscoverySourceType;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly relevanceScore: number;
  readonly safetyLevel: SafetyLevel;
  readonly status: "new" | "evaluated" | "approved" | "rejected" | "implemented";
  readonly implementationBranch?: string;
  readonly createdAt: number;
  readonly evaluatedAt?: number;
  readonly implementedAt?: number;
}

export interface LearningJournalEntry {
  readonly id: string;
  readonly discoveryId: string;
  readonly date: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: string[];
  readonly actionTaken: string;
}
```

**Used by:** `core/learning/`, `cli/commands/learning.ts`.

#### `types/voice.ts` -- Voice Pipeline

```typescript
export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "interrupted";

export interface VoiceConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: number;
  readonly codec: "opus" | "pcm";
  readonly opusBitrate?: number;
}

// WebSocket messages for real-time voice
export interface VoiceClientMessage {
  readonly type: "audio" | "control";
  readonly audio?: Uint8Array;         // Opus-encoded audio chunk
  readonly control?: {
    action: "start" | "stop" | "interrupt" | "config";
    config?: Partial<VoiceConfig>;
  };
}

export interface VoiceServerMessage {
  readonly type: "audio" | "transcript" | "state" | "error";
  readonly audio?: Uint8Array;         // Opus-encoded TTS audio chunk
  readonly transcript?: string;
  readonly state?: VoiceState;
  readonly error?: string;
}

export interface VADConfig {
  readonly endpointingDelayMs: number;
  readonly speechThreshold: number;
  readonly minSpeechDurationMs: number;
  readonly maxSpeechDurationMs: number;
}
```

**Used by:** `core/gpu/`, `apps/desktop/`, Phase 6.

#### `types/database.ts` -- Database Types

```typescript
export type DatabaseName = "memory" | "operational" | "audit";

export interface DatabaseHandle {
  readonly name: DatabaseName;
  readonly path: string;
  readonly db: unknown;               // bun:sqlite Database instance (opaque to protocol)
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;                 // SQL to apply
  readonly down: string;               // SQL to revert
  readonly database: DatabaseName;     // which database this applies to
}
```

**Used by:** `core/database/`.

#### `constants.ts` -- Shared Constants

```typescript
export const VERSION = "0.0.0";

export const DEFAULT_CONFIG_FILENAME = "eidolon.json";
export const DEFAULT_DATA_DIR_NAME = "eidolon";
export const MEMORY_DB_FILENAME = "memory.db";
export const OPERATIONAL_DB_FILENAME = "operational.db";
export const AUDIT_DB_FILENAME = "audit.db";

export const MAX_EMBEDDING_DIMENSIONS = 384;
export const RRF_K = 60;

export const CIRCUIT_BREAKER_DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 3,
} as const;

export const RETRY_DEFAULTS = {
  maxRetries: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
} as const;

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-20250514": { model: "claude-opus-4-20250514", inputPer1M: 1500, outputPer1M: 7500, cacheReadPer1M: 150, cacheWritePer1M: 1875 },
  "claude-sonnet-4-20250514": { model: "claude-sonnet-4-20250514", inputPer1M: 300, outputPer1M: 1500, cacheReadPer1M: 30, cacheWritePer1M: 375 },
  "claude-haiku-3-20250414": { model: "claude-haiku-3-20250414", inputPer1M: 80, outputPer1M: 400, cacheReadPer1M: 8, cacheWritePer1M: 100 },
} as const;

export const SESSION_TOOL_WHITELIST: Record<SessionType, string[]> = {
  main: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch"],
  task: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  learning: ["Read", "Glob", "Grep"],  // restricted: no write, no shell
  dream: ["Read", "Glob", "Grep"],
  voice: ["Read", "Glob", "Grep", "Bash", "WebFetch"],
  review: ["Read", "Glob", "Grep"],
} as const;
```

**Used by:** everywhere.

---

## 4. Phase 0: Foundation

**Duration:** ~2 weeks.
**Goal:** Working monorepo with config, secrets, databases, CLI skeleton, logging, CI, tests.

### 4.1 Build Order (STRICT -- follow this sequence)

```
Step 0.1: Monorepo scaffold & build tooling
Step 0.2: packages/protocol (all shared types)
Step 0.3: packages/test-utils (FakeClaudeProcess + helpers)
Step 0.4: packages/core -- config system
Step 0.5: packages/core -- logging
Step 0.6: packages/core -- secret store
Step 0.7: packages/core -- database layer (3-database split)
Step 0.8: packages/core -- health checks
Step 0.9: packages/core -- token/cost tracking
Step 0.10: packages/core -- backup
Step 0.11: packages/cli -- CLI skeleton (all commands)
Step 0.12: systemd service file
Step 0.13: CI pipeline verification
```

### Step 0.1: Monorepo Scaffold & Build Tooling

**Creates:**

```
tsconfig.base.json                      # shared TypeScript config
biome.json                              # Biome linter/formatter config
packages/protocol/package.json
packages/protocol/tsconfig.json
packages/core/package.json
packages/core/tsconfig.json
packages/cli/package.json
packages/cli/tsconfig.json
packages/test-utils/package.json
packages/test-utils/tsconfig.json
```

**Root `tsconfig.base.json`:**

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"],
    "paths": {
      "@eidolon/protocol": ["../protocol/src"],
      "@eidolon/core": ["../core/src"],
      "@eidolon/cli": ["../cli/src"],
      "@eidolon/test-utils": ["../test-utils/src"]
    }
  }
}
```

**Each package `tsconfig.json` extends base** and adjusts `paths` relative to its position.

**Each package `package.json` includes scripts:**
```json
{
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "lint:fix": "biome check --write src/"
  }
}
```

**Dependencies per package:**

| Package | Dependencies | Dev Dependencies |
|---|---|---|
| `protocol` | `zod` | `bun-types`, `typescript` |
| `core` | `@eidolon/protocol`, `argon2` (Argon2id) | `bun-types`, `typescript`, `@eidolon/test-utils` |
| `cli` | `@eidolon/core`, `@eidolon/protocol`, `commander` | `bun-types`, `typescript` |
| `test-utils` | `@eidolon/protocol` | `bun-types`, `typescript` |

**Compatibility verification (FIRST TASK):**
Before writing any application code, verify:
1. `bun:sqlite` works with `sqlite-vec` extension loading
2. `@huggingface/transformers` runs on Bun (ONNX inference)
3. Document fallbacks if either fails: `better-sqlite3`, native ONNX

**Tests for Step 0.1:** None (scaffold only).

### Step 0.2: packages/protocol

Implement all types from Section 3 above. This is pure type definitions + Zod schemas.

**Files:** All files listed in Section 3.1.
**Tests:** `packages/protocol/src/__tests__/config.test.ts` -- test Zod schema validation (valid config, invalid config, defaults, env overrides).
**Exit criteria:** `pnpm --filter @eidolon/protocol typecheck` passes. Config schema tests pass.

### Step 0.3: packages/test-utils

**Files:**

```
packages/test-utils/src/
  index.ts
  fake-claude-process.ts     # FakeClaudeProcess implements IClaudeProcess
  test-database.ts           # createTestDatabases() -> in-memory SQLite
  test-config.ts             # createTestConfig() -> valid EidolonConfig
  test-events.ts             # createTestEvent() -> BusEvent factory
  test-helpers.ts            # waitFor(), eventually(), timeout helpers
```

**`fake-claude-process.ts`:**

```typescript
export class FakeClaudeProcess implements IClaudeProcess {
  private responses: Map<string, StreamEvent[]>;

  static withResponse(prompt: RegExp, events: StreamEvent[]): FakeClaudeProcess;
  static withToolUse(tool: string, input: Record<string, unknown>, result: unknown): FakeClaudeProcess;
  static withError(code: ErrorCode, message: string): FakeClaudeProcess;

  async *run(prompt: string, options: ClaudeSessionOptions): AsyncIterable<StreamEvent>;
  async isAvailable(): Promise<boolean>;
  async getVersion(): Promise<Result<string, EidolonError>>;
  async abort(sessionId: string): Promise<void>;

  // Test assertions
  getCallCount(): number;
  getLastPrompt(): string | undefined;
  getLastOptions(): ClaudeSessionOptions | undefined;
  getCalls(): Array<{ prompt: string; options: ClaudeSessionOptions }>;
}
```

**Tests:** `packages/test-utils/src/__tests__/fake-claude-process.test.ts` -- verify FakeClaudeProcess responds correctly.
**Exit criteria:** `pnpm --filter @eidolon/test-utils test` passes.

### Step 0.4: packages/core -- Config System

**Files:**

```
packages/core/src/config/
  index.ts                   # export { loadConfig, validateConfig, resolveDefaults }
  loader.ts                  # loadConfig(path?: string): Result<EidolonConfig>
  validator.ts               # validateConfig(raw: unknown): Result<EidolonConfig>
  defaults.ts                # resolveDefaults(config: Partial<EidolonConfig>): EidolonConfig
  env.ts                     # applyEnvOverrides(config: EidolonConfig): EidolonConfig
  watcher.ts                 # ConfigWatcher class (hot-reload via fs.watch)
  paths.ts                   # getConfigPath(), getDataDir(), getPidFilePath() -- platform-aware
```

**Data flow:**
```
eidolon.json (file) --> loader.ts --> validator.ts (Zod parse) --> env.ts (EIDOLON_* overrides) --> defaults.ts --> EidolonConfig
```

**Key logic in `loader.ts`:**
1. Look for config at: explicit path > `$EIDOLON_CONFIG` > `./eidolon.json` > `~/.config/eidolon/eidolon.json`
2. Parse JSON (handle parse errors with Result)
3. Resolve `{ "$secret": "KEY" }` references (deferred until secret store is ready)
4. Validate with Zod
5. Apply `EIDOLON_*` env var overrides (e.g., `EIDOLON_LOGGING_LEVEL=debug`)
6. Fill defaults

**Key logic in `paths.ts`:**
```typescript
export function getDataDir(): string;   // ~/.local/share/eidolon (Linux), ~/Library/Application Support/eidolon (macOS)
export function getConfigDir(): string; // ~/.config/eidolon (Linux), ~/Library/Preferences/eidolon (macOS)
export function getLogDir(): string;    // ~/.local/state/eidolon/logs (Linux)
export function getCacheDir(): string;  // ~/.cache/eidolon (Linux)
```

**Tests:** `packages/core/src/config/__tests__/`
- `loader.test.ts` -- load valid config, missing file, invalid JSON, secret refs
- `validator.test.ts` -- valid config, missing required fields, invalid values, defaults applied
- `env.test.ts` -- env overrides applied correctly, nested paths
- `paths.test.ts` -- platform-specific path resolution

**Exit criteria:** Config loads from file, validates, applies env overrides, fills defaults. 8+ tests pass.

### Step 0.5: packages/core -- Logging

**Files:**

```
packages/core/src/logging/
  index.ts                   # export { createLogger, Logger }
  logger.ts                  # Logger class -- structured JSON logging
  rotation.ts                # LogRotator -- file rotation by size/count
  formatter.ts               # formatLogEntry() -- JSON and pretty formats
```

**Logger API:**

```typescript
export interface Logger {
  debug(module: string, message: string, data?: Record<string, unknown>): void;
  info(module: string, message: string, data?: Record<string, unknown>): void;
  warn(module: string, message: string, data?: Record<string, unknown>): void;
  error(module: string, message: string, error?: unknown, data?: Record<string, unknown>): void;
  child(module: string): Logger;        // creates a sub-logger with fixed module prefix
}

export function createLogger(config: LoggingConfig): Logger;
```

**Output format (JSON):**
```json
{"level":"info","timestamp":1709312400000,"module":"core:config","message":"Config loaded","data":{"path":"/etc/eidolon/eidolon.json"}}
```

**Tests:** `packages/core/src/logging/__tests__/logger.test.ts` -- log levels, JSON format, pretty format, rotation.
**Exit criteria:** Logger writes structured JSON. Rotation works by size. 4+ tests pass.

### Step 0.6: packages/core -- Secret Store

**Files:**

```
packages/core/src/secrets/
  index.ts                   # export { SecretStore }
  store.ts                   # SecretStore class -- CRUD + encryption
  crypto.ts                  # encrypt(), decrypt(), deriveKey() -- AES-256-GCM + Argon2id
  master-key.ts              # getMasterKey(), setMasterKey() -- platform keychain or env
```

**SecretStore API:**

```typescript
export class SecretStore {
  constructor(dbPath: string, masterKey: Uint8Array);

  set(key: string, value: string, description?: string): Result<void, EidolonError>;
  get(key: string): Result<string, EidolonError>;
  delete(key: string): Result<void, EidolonError>;
  list(): Result<SecretMetadata[], EidolonError>;
  has(key: string): boolean;
  rotate(key: string, newValue: string): Result<void, EidolonError>;

  // Resolve { "$secret": "KEY" } references in config
  resolveSecretRefs(config: EidolonConfig): Result<EidolonConfig, EidolonError>;
}
```

**Storage:** Secrets stored in `secrets.db` (separate SQLite file, not part of the 3-database split).

```sql
CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  encrypted_value BLOB NOT NULL,     -- AES-256-GCM ciphertext
  iv BLOB NOT NULL,                  -- 12-byte initialization vector
  auth_tag BLOB NOT NULL,            -- 16-byte authentication tag
  salt BLOB NOT NULL,                -- Argon2id salt
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);
```

**Crypto details:**
- Key derivation: Argon2id (memory: 64MB, iterations: 3, parallelism: 4) from master key
- Encryption: AES-256-GCM with random 12-byte IV per secret
- Master key: from `EIDOLON_MASTER_KEY` env var or platform keychain

**Tests:** `packages/core/src/secrets/__tests__/`
- `store.test.ts` -- set/get/delete/list/rotate, invalid key, decryption with wrong key
- `crypto.test.ts` -- encrypt/decrypt roundtrip, tamper detection, different keys produce different ciphertext

**Exit criteria:** Secrets encrypt/decrypt correctly. Tamper detection works. 6+ tests pass.

### Step 0.7: packages/core -- Database Layer

**Files:**

```
packages/core/src/database/
  index.ts                   # export { DatabaseManager, runMigrations }
  manager.ts                 # DatabaseManager -- manages 3 databases
  migrations.ts              # Migration runner
  connection.ts              # createConnection() -- bun:sqlite wrapper with WAL mode
  schemas/
    memory.ts                # Memory DB migrations (version 1+)
    operational.ts           # Operational DB migrations (version 1+)
    audit.ts                 # Audit DB migrations (version 1+)
```

**DatabaseManager API:**

```typescript
export class DatabaseManager {
  readonly memory: Database;           // bun:sqlite Database
  readonly operational: Database;
  readonly audit: Database;

  constructor(config: DatabaseConfig, logger: Logger);

  async initialize(): Promise<Result<void, EidolonError>>;  // open all 3, run migrations
  async close(): Promise<void>;
  async backup(targetDir: string): Promise<Result<void, EidolonError>>;
  async vacuum(): Promise<void>;
  getStats(): { memory: DbStats; operational: DbStats; audit: DbStats };
}

interface DbStats {
  readonly path: string;
  readonly sizeBytes: number;
  readonly tableCount: number;
  readonly walSizeBytes: number;
}
```

**Migration system:**
```typescript
export async function runMigrations(
  db: Database,
  dbName: DatabaseName,
  migrations: Migration[],
  logger: Logger,
): Promise<Result<void, EidolonError>>;
```

Each database has a `_migrations` table:
```sql
CREATE TABLE _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

**See Section 15 for complete SQL schemas.**

**Tests:** `packages/core/src/database/__tests__/`
- `manager.test.ts` -- initialize 3 DBs, WAL mode enabled, close, backup
- `migrations.test.ts` -- apply migrations, skip already applied, rollback on error
- `connection.test.ts` -- WAL mode, busy timeout, concurrent reads

**Exit criteria:** 3 databases created with correct schemas. Migrations run idempotently. WAL mode verified. 6+ tests pass.

### Step 0.8: packages/core -- Health Checks

**Files:**

```
packages/core/src/health/
  index.ts                   # export { HealthChecker, CircuitBreaker }
  checker.ts                 # HealthChecker -- runs all checks, aggregates status
  circuit-breaker.ts         # CircuitBreaker -- generic circuit breaker implementation
  checks/
    bun.ts                   # check Bun version
    claude.ts                # check Claude Code CLI installed
    config.ts                # check config valid
    database.ts              # check databases writable
    disk.ts                  # check disk space
```

**CircuitBreaker API:**

```typescript
export class CircuitBreaker {
  constructor(config: CircuitBreakerConfig, logger: Logger);

  async execute<T>(fn: () => Promise<T>): Promise<Result<T, EidolonError>>;
  getStatus(): CircuitBreakerStatus;
  reset(): void;
}
```

State transitions:
```
CLOSED --[failureThreshold failures]--> OPEN --[resetTimeout]--> HALF_OPEN
HALF_OPEN --[success]--> CLOSED
HALF_OPEN --[failure]--> OPEN
```

**Tests:** `packages/core/src/health/__tests__/`
- `circuit-breaker.test.ts` -- state transitions, timeout, half-open probing
- `checker.test.ts` -- all checks pass, one fails -> degraded, all fail -> unhealthy

**Exit criteria:** Circuit breaker transitions correctly. Health checker aggregates. 5+ tests pass.

### Step 0.9: packages/core -- Token/Cost Tracking

**Files:**

```
packages/core/src/metrics/
  index.ts                   # export { TokenTracker, CostCalculator }
  token-tracker.ts           # TokenTracker -- records usage per session
  cost.ts                    # CostCalculator -- calculates cost from token counts
```

**TokenTracker API:**

```typescript
export class TokenTracker {
  constructor(db: Database, logger: Logger);

  record(usage: TokenUsage): Result<void, EidolonError>;
  getSummary(period: "hour" | "day" | "week" | "month"): Result<CostSummary, EidolonError>;
  getSessionUsage(sessionId: string): Result<TokenUsage[], EidolonError>;
  getTotalForPeriod(startMs: number, endMs: number): Result<CostSummary, EidolonError>;
}
```

**Tests:** `packages/core/src/metrics/__tests__/token-tracker.test.ts` -- record usage, summarize by period, cost calculation.
**Exit criteria:** Token usage recorded and queried correctly. Cost calculations match manual verification. 3+ tests pass.

### Step 0.10: packages/core -- Backup

**Files:**

```
packages/core/src/backup/
  index.ts                   # export { BackupManager }
  manager.ts                 # BackupManager -- daily SQLite backup
```

**BackupManager API:**

```typescript
export class BackupManager {
  constructor(dbManager: DatabaseManager, config: DatabaseConfig, logger: Logger);

  async runBackup(): Promise<Result<string, EidolonError>>;  // returns backup path
  async listBackups(): Promise<Result<string[], EidolonError>>;
  async pruneOldBackups(keepDays: number): Promise<Result<number, EidolonError>>;
}
```

Uses SQLite `.backup()` API for consistent hot backups.

**Tests:** `packages/core/src/backup/__tests__/manager.test.ts` -- backup creates files, prune removes old.
**Exit criteria:** Backup creates consistent copies of all 3 databases. 2+ tests pass.

### Step 0.11: packages/cli -- CLI Skeleton

**Files:**

```
packages/cli/src/
  index.ts                   # CLI entry point -- parse args, route to commands
  commands/
    daemon.ts                # eidolon daemon start|stop|status
    config.ts                # eidolon config show|validate|set
    secrets.ts               # eidolon secrets set|get|list|delete|rotate
    doctor.ts                # eidolon doctor (system diagnostics)
    chat.ts                  # eidolon chat (interactive, Phase 1 stub)
    memory.ts                # eidolon memory search|dream|stats (Phase 2 stub)
    learning.ts              # eidolon learning status|approve (Phase 5 stub)
    channel.ts               # eidolon channel telegram status (Phase 4 stub)
    privacy.ts               # eidolon privacy forget|export (Phase 9 stub)
  utils/
    formatter.ts             # output formatting (table, JSON, color)
    process.ts               # daemon process management (PID file, signal handling)
    prompts.ts               # interactive prompts (password input for master key)
```

**CLI framework:** Use `commander` for command parsing.

**Entry point (`index.ts`):**
```typescript
#!/usr/bin/env bun
import { program } from "commander";
// register all commands...
program.parse();
```

**Phase 0 commands that fully work:**
- `eidolon doctor` -- checks Bun version, Claude Code installed, config valid, DBs writable
- `eidolon config show` -- display resolved config
- `eidolon config validate` -- validate config file
- `eidolon secrets set <key>` -- store encrypted secret (prompts for value)
- `eidolon secrets get <key>` -- retrieve and display (masked by default)
- `eidolon secrets list` -- list all secret keys with metadata
- `eidolon secrets delete <key>` -- remove a secret
- `eidolon daemon status` -- show if daemon is running (PID file check)

**Phase 0 commands that are stubs** (print "Not yet implemented -- Phase N"):
- `eidolon daemon start`, `eidolon daemon stop` (Phase 3)
- `eidolon chat` (Phase 1)
- `eidolon memory *` (Phase 2)
- `eidolon learning *` (Phase 5)
- `eidolon channel *` (Phase 4)
- `eidolon privacy *` (Phase 9)

**Tests:** `packages/cli/src/__tests__/`
- `doctor.test.ts` -- mock health checker, verify output
- `config.test.ts` -- show/validate commands
- `secrets.test.ts` -- set/get/list/delete flow

**Exit criteria:** `eidolon doctor` passes all checks. `eidolon secrets set/get/list` works. 5+ tests pass.

### Step 0.12: systemd Service File

**Creates:** `deploy/eidolon.service`

```ini
[Unit]
Description=Eidolon AI Assistant Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=eidolon
Group=eidolon
WorkingDirectory=/opt/eidolon
ExecStart=/usr/local/bin/bun /opt/eidolon/packages/cli/dist/eidolon daemon start --foreground
ExecStop=/bin/kill -SIGTERM $MAINPID
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/eidolon /var/log/eidolon
PrivateTmp=yes

# Environment
Environment=EIDOLON_CONFIG=/etc/eidolon/eidolon.json
Environment=EIDOLON_DATA_DIR=/var/lib/eidolon
Environment=EIDOLON_LOG_DIR=/var/log/eidolon

[Install]
WantedBy=multi-user.target
```

**Also creates:** `deploy/eidolon-backup.timer` and `deploy/eidolon-backup.service` for daily backup.

### Step 0.13: CI Pipeline Verification

Verify that the existing CI pipeline (`ci.yml`) now works with real packages:
- `pnpm -r lint` passes (Biome)
- `pnpm -r typecheck` passes (tsc --noEmit)
- `pnpm -r test` passes (bun test)
- `pnpm -r build` succeeds

### Phase 0 Test Summary

| Module | Test File | Test Count | What It Verifies |
|---|---|---|---|
| Config | `config/loader.test.ts` | 4 | Load, missing file, invalid JSON, secret refs |
| Config | `config/validator.test.ts` | 4 | Valid, invalid, defaults, nested validation |
| Config | `config/env.test.ts` | 3 | Env overrides, nested paths, type coercion |
| Secrets | `secrets/store.test.ts` | 4 | Set/get/delete/rotate, wrong key error |
| Secrets | `secrets/crypto.test.ts` | 3 | Roundtrip, tamper detection, key isolation |
| Database | `database/manager.test.ts` | 3 | Initialize, WAL mode, backup |
| Database | `database/migrations.test.ts` | 3 | Apply, idempotent, rollback |
| Health | `health/circuit-breaker.test.ts` | 3 | State transitions, timeout, half-open |
| Health | `health/checker.test.ts` | 2 | All pass, partial fail |
| Metrics | `metrics/token-tracker.test.ts` | 3 | Record, summarize, cost calc |
| Backup | `backup/manager.test.ts` | 2 | Backup, prune |
| CLI | `cli/doctor.test.ts` | 2 | Pass, fail scenarios |
| CLI | `cli/secrets.test.ts` | 2 | Set/get flow |
| Protocol | `protocol/config.test.ts` | 3 | Schema validation |
| TestUtils | `test-utils/fake.test.ts` | 2 | Response, error scenarios |
| **Total** | | **~43** | |

---

## 5. Phase 1: Brain

**Duration:** ~2 weeks.
**Goal:** Send a message to Claude Code CLI, get a response. Multi-account rotation.
**Depends on:** Phase 0 complete.

### Build Order

```
Step 1.1: ClaudeCodeManager (implements IClaudeProcess)
Step 1.2: AccountRotation
Step 1.3: WorkspacePreparer (CLAUDE.md, SOUL.md injection)
Step 1.4: Session management (resume, multi-turn)
Step 1.5: MCP server passthrough
Step 1.6: CLI chat command
Step 1.7: Health check endpoint (HTTP)
```

### Files

```
packages/core/src/claude/
  index.ts
  manager.ts                 # ClaudeCodeManager implements IClaudeProcess
  account-rotation.ts        # AccountRotation -- select best account, failover
  workspace.ts               # WorkspacePreparer -- create workspace, inject CLAUDE.md
  session.ts                 # SessionManager -- track active sessions, resume
  parser.ts                  # parseStreamEvents() -- parse Claude Code JSON output
  mcp.ts                     # generateMcpConfig() -- create MCP config file for --mcp-config
```

### Key Implementation Details

**`manager.ts` -- ClaudeCodeManager:**
- Spawns Claude Code CLI via `Bun.spawn()`
- Pipes: stdin for prompt, stdout for streaming JSON events
- CLI invocation: `claude --print --output-format stream-json --session-id <id> --project <dir> --model <model> --allowedTools <tools> --mcp-config <path> --max-turns <n> --system-prompt <text>`
- Env isolation: API key set ONLY in subprocess env, cleared after spawn
- Timeout: kill process after configurable timeout
- Parse stdout line-by-line, yield `StreamEvent` objects

**`account-rotation.ts` -- AccountRotation:**
- Select account by: priority (highest first) > remaining quota > last error time
- Track per-account: tokens used (current hour), last error, consecutive failures
- Failover: if current account gets 429 (rate limited), mark it, try next
- All accounts exhausted: return `Err(CLAUDE_RATE_LIMITED)` with retry-after estimate

**`workspace.ts` -- WorkspacePreparer:**
- For each session, create temp workspace: `{cacheDir}/workspaces/{sessionId}/`
- Write `CLAUDE.md` with: system role, current context, relevant memories (from Phase 2)
- Write `SOUL.md` with: personality traits, response style guidelines
- Clean up old workspaces (>24h, no active session)

### Tests

| Test File | Tests | What It Verifies |
|---|---|---|
| `claude/manager.test.ts` | 5 | Run with FakeClaudeProcess, streaming events, timeout, abort, env isolation |
| `claude/account-rotation.test.ts` | 4 | Priority selection, failover on rate limit, all exhausted, recovery |
| `claude/workspace.test.ts` | 3 | Create workspace, inject CLAUDE.md, cleanup old |
| `claude/session.test.ts` | 3 | Create session, resume with --session-id, session listing |
| `claude/parser.test.ts` | 3 | Parse text event, tool_use event, error event |
| `cli/chat.test.ts` | 2 | Send message, multi-turn |
| **Total** | **~20** | |

---

## 6. Phase 2: Memory

**Duration:** ~2 weeks.
**Goal:** Auto-extract memories, search with BM25+vector+graph, dreaming consolidation.
**Depends on:** Phase 1 complete.

### Build Order

```
Step 2.1: MemoryStore (CRUD)
Step 2.2: Embeddings (multilingual-e5-small via @huggingface/transformers)
Step 2.3: MemoryExtractor (auto-extraction from conversations)
Step 2.4: MemorySearch (BM25 + vector + RRF)
Step 2.5: Graph memory (edges, graph-walk expansion)
Step 2.6: Knowledge Graph (entities, relations, ComplEx)
Step 2.7: MemoryInjector (write MEMORY.md before sessions)
Step 2.8: Document indexing
Step 2.9: Dreaming (3 phases: housekeeping, REM, NREM)
Step 2.10: CLI memory commands
```

### Files

```
packages/core/src/memory/
  index.ts
  store.ts                   # MemoryStore -- CRUD on memories table
  extractor.ts               # MemoryExtractor -- analyze conversations, extract facts
  search.ts                  # MemorySearch -- BM25 + vector + graph + RRF fusion
  injector.ts                # MemoryInjector -- select & write MEMORY.md
  embeddings.ts              # EmbeddingModel -- load and run multilingual-e5-small
  graph.ts                   # GraphMemory -- edge CRUD, graph-walk expansion
  knowledge-graph/
    index.ts
    entities.ts              # KG entity CRUD, entity resolution
    relations.ts             # KG relation CRUD, extraction from text
    complex.ts               # ComplEx embedding training & scoring
    communities.ts           # Leiden community detection, PageRank
  document-indexer.ts        # Index markdown, text, PDF, code files
  dreaming/
    index.ts
    scheduler.ts             # DreamScheduler -- when to dream
    housekeeping.ts          # Phase 1: dedup, decay, contradiction resolution
    rem.ts                   # Phase 2: associative discovery, edge creation
    nrem.ts                  # Phase 3: schema abstraction, skill extraction
```

### Key Implementation Details

**`search.ts` -- Reciprocal Rank Fusion:**
```typescript
// RRF formula: score = Σ 1/(k + rank_i)
// k = 60 (standard constant from config)
//
// Search pipeline:
// 1. BM25 search via FTS5 -> ranked list
// 2. Vector search via sqlite-vec -> ranked list
// 3. Graph expansion (optional) -> bonus scores
// 4. Fuse with RRF -> final ranked results
```

**`embeddings.ts` -- Local Embeddings:**
```typescript
export class EmbeddingModel {
  private pipeline: unknown; // @huggingface/transformers pipeline

  async initialize(): Promise<Result<void, EidolonError>>;
  async embed(text: string): Promise<Result<Float32Array, EidolonError>>;
  async embedBatch(texts: string[]): Promise<Result<Float32Array[], EidolonError>>;
}
```

**`extractor.ts` -- Memory Extraction Strategies:**
```
hybrid (default):
  1. Rule-based: regex patterns for dates, names, preferences, decisions
  2. LLM: Claude analyzes conversation turns, returns structured facts
  3. Merge: deduplicate, take highest confidence
```

### Tests: ~25 tests covering store CRUD, embedding roundtrip, search ranking, extraction accuracy, dreaming phases, graph expansion.

---

## 7. Phase 3: Cognitive Loop

**Duration:** ~2 weeks.
**Goal:** Autonomous PEAR loop, multi-session, event bus, energy budget.
**Depends on:** Phase 2 complete.

### Files

```
packages/core/src/loop/
  index.ts
  cognitive-loop.ts          # CognitiveLoop -- main PEAR cycle
  event-bus.ts               # EventBus -- typed pub/sub, persisted to SQLite
  session-supervisor.ts      # SessionSupervisor -- manage concurrent sessions
  priority.ts                # PriorityEvaluator -- score events
  energy-budget.ts           # EnergyBudget -- token allocation
  rest.ts                    # RestCalculator -- adaptive sleep duration
  state-machine.ts           # CognitiveState transitions

packages/core/src/scheduler/
  index.ts
  scheduler.ts               # TaskScheduler -- cron, one-off, conditional tasks
```

### Key Implementation Details

**Cognitive Loop Cycle:**
```
while (running) {
  // 1. PERCEIVE: dequeue highest-priority event from EventBus
  const event = await eventBus.dequeue();
  if (!event) { await rest(); continue; }

  // 2. EVALUATE: score priority, check energy budget
  const priority = evaluator.score(event);
  if (!energyBudget.canAfford(priority)) { eventBus.defer(event); continue; }

  // 3. ACT: route to appropriate session/handler
  const session = await supervisor.getOrCreate(event);
  const result = await session.handle(event);

  // 4. REFLECT: extract memories, update state, log metrics
  await extractor.processResult(result);
  await tokenTracker.record(result.usage);
  energyBudget.consume(result.usage);
}
```

**EventBus persistence:** Every event written to `operational.db` `events` table before processing. Marked as processed after handler completes. On crash restart, replay unprocessed events.

**Session concurrency table:**
| Session Type | Max Concurrent | Interruptible | Priority |
|---|---|---|---|
| main | 1 | no | highest |
| voice | 1 | yes (by user) | high |
| task | 3 | yes | normal |
| learning | 1 | yes | low |
| dream | 1 | yes | lowest |

### Tests: ~20 tests covering loop cycle, event persistence, priority scoring, energy budget enforcement, session supervision, rest calculation, scheduler.

---

## 8. Phase 4: Telegram

**Duration:** ~1 week.
**Goal:** Full conversation via Telegram.
**Depends on:** Phase 3 complete.

### Files

```
packages/core/src/channels/
  index.ts
  router.ts                  # MessageRouter -- route inbound to EventBus, outbound to channel
  telegram/
    index.ts
    channel.ts               # TelegramChannel implements Channel
    formatter.ts             # Format Claude markdown for Telegram
    media.ts                 # Handle photos, documents, voice messages
```

### Key Implementation Details

- Uses `grammy` library for Telegram Bot API
- Long polling (not webhooks -- simpler for home server)
- User allowlist from config (`channels.telegram.allowedUserIds`)
- Streaming: send "typing..." indicator, then edit message with final response
- Voice messages: save audio, send to STT (Phase 6 -- for now, transcription stub)

### Tests: ~8 tests with mocked grammy bot.

---

## 9. Phase 4.5: Home Automation

**Duration:** ~1 week.
**Goal:** Basic Home Assistant control via MCP.
**Depends on:** Phase 4 complete.

### Implementation

- Configure `mcp-server-home-assistant` in `brain.mcpServers`
- Define security policies: lights/switches = `safe`, locks/alarms = `needs_approval`
- Entity resolution: map "Wohnzimmer Licht" to `light.living_room`
- No new code files needed -- configuration + security policy rules only
- Tests: integration test with FakeClaudeProcess simulating HA tool calls

---

## 10. Phase 5: Self-Learning

**Duration:** ~2 weeks.
**Goal:** Autonomous discovery, evaluation, implementation pipeline.
**Depends on:** Phase 3 complete (can parallel with Phase 4).

### Files

```
packages/core/src/learning/
  index.ts
  discovery.ts               # DiscoveryEngine -- crawl configured sources
  relevance.ts               # RelevanceFilter -- LLM-scored relevance
  safety.ts                  # SafetyClassifier -- safe/needs_approval/dangerous
  implementation.ts          # ImplementationPipeline -- feature branch, lint, test
  journal.ts                 # LearningJournal -- markdown entries
  deduplication.ts           # Skip already-known content
```

### Key Implementation Details

**Safety rule (ABSOLUTE):** Code changes are NEVER classified as `safe`. Always `needs_approval` at minimum.

**Implementation pipeline:**
```
1. Create git worktree for feature branch
2. Spawn Claude Code session with restricted tools
3. Auto-lint (biome) and auto-test (bun test)
4. If tests fail: abort, report failure
5. If tests pass: create PR description, notify user for approval
6. User approves -> merge. User rejects -> delete branch.
```

### Tests: ~12 tests covering discovery, filtering, safety classification, implementation flow.

---

## 11. Phase 6: Voice

**Duration:** ~2 weeks.
**Goal:** Voice conversations via GPU worker.
**Depends on:** Phase 4 complete.

### GPU Worker (Python)

```
services/gpu-worker/
  pyproject.toml
  Dockerfile.cuda
  docker-compose.yml
  src/
    main.py                  # FastAPI app
    auth.py                  # Pre-shared key authentication
    tts.py                   # Qwen3-TTS model loading and inference
    stt.py                   # faster-whisper transcription
    voice_ws.py              # WebSocket real-time voice endpoint
    health.py                # GPU health check (utilization, VRAM, temp)
```

### Core Voice Pipeline

```
packages/core/src/gpu/
  index.ts
  manager.ts                 # GPUManager -- discover workers, health monitoring
  voice-pipeline.ts          # StreamingVoicePipeline -- sentence-level TTS chunking
  tts-client.ts              # HTTP client for POST /tts/stream
  stt-client.ts              # HTTP client for POST /stt/transcribe
  realtime-client.ts         # WebSocket client for WS /voice/realtime
  fallback.ts                # TTS fallback chain: Qwen3 -> Kitten -> System -> text
```

### Key Implementation Details

**TTS chunking:** Use `Intl.Segmenter` for sentence detection (not regex).
**Audio:** Opus codec over WebSocket (not raw PCM).
**State machine:** idle -> listening -> processing -> speaking -> interrupted.

### Tests: ~10 tests (TTS client mock, STT client mock, pipeline, state machine, fallback chain).

---

## 12. Phase 7: Desktop Client

**Duration:** ~2 weeks.
**Goal:** Tauri 2.0 native app for macOS/Windows/Linux.
**Depends on:** Phase 3 complete (gateway server).

### Structure

```
apps/desktop/
  package.json
  src-tauri/
    Cargo.toml
    src/
      main.rs                # Tauri app entry
      commands.rs            # Rust backend commands
      tray.rs                # System tray integration
    tauri.conf.json
    capabilities/
      default.json
  src/                       # Svelte frontend
    App.svelte
    lib/
      api.ts                 # WebSocket client to Core gateway
      stores/                # Svelte stores for state
    routes/
      chat/
      memory/
      learning/
      settings/
```

### Connection

Desktop connects to Core via WebSocket (JSON-RPC 2.0) on `gateway.port` (default 8419).
Authentication via token from config.

---

## 13. Phase 8: iOS Client

**Duration:** ~6 weeks.
**Goal:** Native iPhone/iPad app.
**Depends on:** Phase 3 complete (gateway server).

### Structure

```
apps/ios/
  Eidolon.xcodeproj
  Eidolon/
    App.swift
    Services/
      WebSocketService.swift
      NetworkManager.swift    # Bonjour -> Tailscale -> Cloudflare Tunnel
      PushNotificationService.swift
    Views/
      ChatView.swift
      MemoryView.swift
      SettingsView.swift
    Models/
      Message.swift
      Memory.swift
```

### Networking

1. Try Bonjour (local network)
2. Try Tailscale IP
3. Try Cloudflare Tunnel URL
4. Manual IP entry

### Push Notifications

Core sends push via APNs. Requires:
- `packages/core/src/notifications/apns.ts` -- APNs client
- Apple Developer Account (user declined for now -- prepare but don't activate)

---

## 14. Phase 9: Polish & Release

**Duration:** ~1 week.
**Goal:** Production-ready v1.0.

### Deliverables

- `eidolon onboard` wizard (interactive first-time setup)
- `eidolon privacy forget <entity>` (GDPR: cascading delete)
- `eidolon privacy export` (GDPR: JSON export)
- Performance tuning (database indexes, query optimization)
- README update with screenshots
- GitHub Release v1.0.0

---

## 15. Database Schemas

### 15.1 memory.db

```sql
-- Version 1 (Phase 0)
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','episode','skill','relationship','schema')),
  layer TEXT NOT NULL CHECK(layer IN ('working','short_term','long_term','episodic','procedural')),
  content TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',              -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT DEFAULT '{}'                    -- JSON object
);

CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_layer ON memories(layer);
CREATE INDEX idx_memories_confidence ON memories(confidence);
CREATE INDEX idx_memories_created_at ON memories(created_at);

-- FTS5 for BM25 search
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  content=memories,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

-- Vector embeddings (sqlite-vec)
-- Created programmatically: db.exec("CREATE VIRTUAL TABLE memory_embeddings USING vec0(embedding float[384])")
-- Linked to memories by rowid

-- Memory graph edges
CREATE TABLE memory_edges (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, relation)
);

CREATE INDEX idx_edges_source ON memory_edges(source_id);
CREATE INDEX idx_edges_target ON memory_edges(target_id);

-- Knowledge Graph entities
CREATE TABLE kg_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  attributes TEXT NOT NULL DEFAULT '{}',        -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_kg_entities_type ON kg_entities(type);
CREATE INDEX idx_kg_entities_name ON kg_entities(name);

-- KG entity embeddings (sqlite-vec)
-- Created programmatically: CREATE VIRTUAL TABLE kg_entity_embeddings USING vec0(embedding float[384])

-- Knowledge Graph relations
CREATE TABLE kg_relations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_kg_relations_source ON kg_relations(source_id);
CREATE INDEX idx_kg_relations_target ON kg_relations(target_id);
CREATE INDEX idx_kg_relations_type ON kg_relations(type);

-- KG communities (Leiden algorithm output)
CREATE TABLE kg_communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_ids TEXT NOT NULL,                     -- JSON array of entity IDs
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ComplEx embeddings for KG
CREATE TABLE kg_complex_embeddings (
  entity_id TEXT PRIMARY KEY REFERENCES kg_entities(id) ON DELETE CASCADE,
  real_embedding BLOB NOT NULL,                 -- Float32Array serialized
  imaginary_embedding BLOB NOT NULL,            -- Float32Array serialized
  updated_at INTEGER NOT NULL
);
```

### 15.2 operational.db

```sql
-- Version 1 (Phase 0)

-- Active and historical sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('main','task','learning','dream','voice','review')),
  status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed')),
  claude_session_id TEXT,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  completed_at INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_type ON sessions(type);

-- Event Bus (persisted for crash recovery)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('critical','high','normal','low')),
  payload TEXT NOT NULL,                        -- JSON
  source TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  processed_at INTEGER,                         -- NULL = not yet processed
  retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;
CREATE INDEX idx_events_priority ON events(priority, timestamp);

-- Cognitive loop state
CREATE TABLE loop_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Token usage tracking
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  session_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX idx_token_usage_session ON token_usage(session_id);
CREATE INDEX idx_token_usage_timestamp ON token_usage(timestamp);

-- Scheduled tasks
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('once','recurring','conditional')),
  cron TEXT,
  run_at INTEGER,
  condition TEXT,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_next_run ON scheduled_tasks(next_run_at) WHERE enabled = 1;

-- Self-learning discoveries
CREATE TABLE discoveries (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  safety_level TEXT NOT NULL CHECK(safety_level IN ('safe','needs_approval','dangerous')),
  status TEXT NOT NULL CHECK(status IN ('new','evaluated','approved','rejected','implemented')),
  implementation_branch TEXT,
  created_at INTEGER NOT NULL,
  evaluated_at INTEGER,
  implemented_at INTEGER
);

CREATE INDEX idx_discoveries_status ON discoveries(status);

-- Circuit breaker state
CREATE TABLE circuit_breakers (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('closed','open','half_open')),
  failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  last_success_at INTEGER,
  next_probe_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Account usage tracking
CREATE TABLE account_usage (
  account_name TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,                 -- hour timestamp (floored)
  tokens_used INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (account_name, hour_bucket)
);
```

### 15.3 audit.db

```sql
-- Version 1 (Phase 0)

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('success','failure','denied')),
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_actor ON audit_log(actor);
CREATE INDEX idx_audit_action ON audit_log(action);
```

---

## 16. Cross-Cutting Patterns

### 16.1 Error Handling

```
Expected errors -> Result<T, EidolonError>
  Examples: file not found, invalid config, rate limited, secret not found

Programming bugs -> throw
  Examples: null where shouldn't be, impossible state, type assertion failure

NEVER: catch-all try/catch that swallows errors
NEVER: console.log for errors -- always use Logger
```

### 16.2 Retry with Exponential Backoff

```typescript
// Used by: ClaudeCodeManager, GPUManager, TelegramChannel
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config: { maxRetries: number; initialDelayMs: number; maxDelayMs: number; backoffMultiplier: number },
  shouldRetry: (error: unknown) => boolean,
): Promise<Result<T, EidolonError>>;

// Delay calculation: min(initialDelay * backoffMultiplier^attempt, maxDelay)
// Default: 1s -> 2s -> 4s -> 8s -> 16s -> 32s -> 60s (capped)
```

### 16.3 Testing Patterns

```
- ALL tests use in-memory SQLite (`:memory:`)
- ALL tests use FakeClaudeProcess (never real Claude Code)
- ALL tests use test config factory (createTestConfig())
- Database tests: createTestDatabases() -> 3 in-memory DBs with schemas applied
- Time-sensitive tests: use injectable clock (not Date.now())
- Async tests: use waitFor() helper with configurable timeout
```

### 16.4 Module Initialization Order

When the daemon starts, modules initialize in this order:

```
1. Logger (no deps)
2. Config (needs Logger)
3. SecretStore (needs Config for master key path)
4. Config with secrets resolved (needs SecretStore)
5. DatabaseManager (needs Config, Logger)
6. HealthChecker (needs DatabaseManager, Logger)
7. TokenTracker (needs DatabaseManager, Logger)
8. BackupManager (needs DatabaseManager, Config, Logger)
9. EmbeddingModel (needs Config, Logger) -- Phase 2
10. MemoryStore (needs DatabaseManager, Logger) -- Phase 2
11. MemorySearch (needs MemoryStore, EmbeddingModel) -- Phase 2
12. ClaudeCodeManager (needs Config, AccountRotation, Logger) -- Phase 1
13. EventBus (needs DatabaseManager, Logger) -- Phase 3
14. SessionSupervisor (needs ClaudeCodeManager, Config, Logger) -- Phase 3
15. CognitiveLoop (needs EventBus, SessionSupervisor, ...) -- Phase 3
16. Channels (needs EventBus, Config, Logger) -- Phase 4
17. Gateway (needs EventBus, Config, Logger) -- Phase 7
18. GPUManager (needs Config, Logger) -- Phase 6
```

### 16.5 Shutdown Sequence

```
1. Stop accepting new events (EventBus.pause())
2. Signal all sessions to complete current turn
3. Wait up to gracefulShutdownMs for sessions to finish
4. Force-terminate remaining sessions
5. Flush pending metrics
6. Close channels (Telegram disconnect, WebSocket close)
7. Close databases (WAL checkpoint, then close)
8. Remove PID file
9. Exit
```

---

## 17. Complete File Index

Total estimated lines of own code (excluding tests):

| Package | Files | Estimated Lines |
|---|---|---|
| `packages/protocol` | 17 | ~1,040 |
| `packages/core` | 48 | ~5,860 |
| `packages/cli` | 13 | ~890 |
| `packages/test-utils` | 6 | ~340 |
| `services/gpu-worker` | 6 | ~600 (Python) |
| `deploy/` | 3 | ~80 |
| **Total own code** | **93** | **~8,810** |
| Tests (not counted) | ~40 | ~2,500 |
| apps/desktop (Svelte+Tauri) | ~20 | ~2,000 |
| apps/ios (Swift) | ~15 | ~3,000 |

### Phase-by-Phase File Creation

**Phase 0 creates:** ~30 files (protocol: 17, core: 8 modules, cli: 5 core commands, test-utils: 6, deploy: 3)
**Phase 1 creates:** ~7 files (core/claude/)
**Phase 2 creates:** ~14 files (core/memory/)
**Phase 3 creates:** ~8 files (core/loop/, core/scheduler/)
**Phase 4 creates:** ~4 files (core/channels/telegram/)
**Phase 4.5 creates:** ~0 files (config only)
**Phase 5 creates:** ~6 files (core/learning/)
**Phase 6 creates:** ~12 files (core/gpu/ + services/gpu-worker/)
**Phase 7 creates:** ~20 files (apps/desktop/)
**Phase 8 creates:** ~15 files (apps/ios/)
**Phase 9 creates:** ~2 files (onboard command, privacy commands)

---

## Appendix A: Data Flow Diagrams

### A.1 User Message Flow (Telegram)

```
User types in Telegram
  -> grammY receives update
  -> TelegramChannel.onMessage()
  -> Creates InboundMessage
  -> MessageRouter.route()
  -> EventBus.emit("user:message", payload)
  -> CognitiveLoop.perceive() dequeues event
  -> PriorityEvaluator.score() -> highest priority
  -> SessionSupervisor.getOrCreate("main")
  -> MemoryInjector.prepare() -> writes MEMORY.md
  -> WorkspacePreparer.prepare() -> creates workspace
  -> ClaudeCodeManager.run(prompt, options)
  -> Claude Code CLI processes (streaming events)
  -> Parser yields StreamEvent objects
  -> Response text collected
  -> MemoryExtractor.extract(conversation)
  -> MemoryStore.save(extractedMemories)
  -> MessageRouter.send(OutboundMessage)
  -> TelegramChannel.send()
  -> User sees response in Telegram
```

### A.2 Dreaming Flow

```
DreamScheduler checks time (02:00 default)
  -> EventBus.emit("memory:dream_start")
  -> SessionSupervisor creates "dream" session
  -> Phase 1 Housekeeping:
     -> Scan memories older than 24h
     -> Dedup (cosine similarity > threshold)
     -> Decay (reduce confidence by decayRate)
     -> Contradiction resolution (LLM picks winner)
  -> Phase 2 REM:
     -> Random memory pairs
     -> LLM finds unexpected associations
     -> Create memory_edges for discoveries
     -> ComplEx training batch
  -> Phase 3 NREM:
     -> Leiden community detection on KG
     -> LLM abstracts rules from clusters
     -> Create "schema" memories
     -> Extract "skill" memories from patterns
  -> Record DreamingResult
  -> EventBus.emit("memory:dream_complete")
```

### A.3 Self-Learning Flow

```
DiscoveryEngine polls configured sources
  -> Fetches new content (HTTP)
  -> Content sanitization (strip injection patterns)
  -> RelevanceFilter.score() (LLM evaluation, restricted tools)
  -> Score >= minScore?
     -> No: discard
     -> Yes: store in discoveries table
  -> SafetyClassifier.classify()
     -> "safe" (knowledge only): store in memory
     -> "needs_approval" (code change): queue for user
     -> "dangerous": discard + audit log
  -> User approves?
     -> ImplementationPipeline:
        -> Create git worktree
        -> Spawn Claude Code session (restricted tools)
        -> Auto-lint (biome)
        -> Auto-test (bun test)
        -> Tests pass? -> Notify user: "Ready to merge"
        -> Tests fail? -> Abort, report failure
```

---

## Appendix B: Configuration Example (Minimal)

```json
{
  "identity": {
    "ownerName": "Manuel"
  },
  "brain": {
    "accounts": [
      {
        "type": "oauth",
        "name": "primary",
        "credential": { "$secret": "ANTHROPIC_OAUTH_TOKEN" },
        "priority": 100
      }
    ]
  }
}
```

All other values use defaults from the Zod schema.

## Appendix C: Configuration Example (Full Production)

```json
{
  "identity": {
    "name": "Eidolon",
    "ownerName": "Manuel"
  },
  "brain": {
    "accounts": [
      {
        "type": "oauth",
        "name": "max-primary",
        "credential": { "$secret": "ANTHROPIC_OAUTH_PRIMARY" },
        "priority": 100,
        "maxTokensPerHour": 200000
      },
      {
        "type": "api-key",
        "name": "api-overflow",
        "credential": { "$secret": "ANTHROPIC_API_KEY" },
        "priority": 50,
        "maxTokensPerHour": 100000
      }
    ],
    "model": {
      "default": "claude-sonnet-4-20250514",
      "complex": "claude-opus-4-20250514",
      "fast": "claude-haiku-3-20250414"
    },
    "mcpServers": {
      "home-assistant": {
        "command": "npx",
        "args": ["-y", "mcp-server-home-assistant"],
        "env": { "HA_TOKEN": "$secret:HA_TOKEN", "HA_URL": "http://homeassistant.local:8123" }
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": { "$secret": "TELEGRAM_BOT_TOKEN" },
      "allowedUserIds": [123456789]
    }
  },
  "gpu": {
    "workers": [
      {
        "name": "windows-rtx5080",
        "host": "100.64.0.2",
        "port": 8420,
        "token": { "$secret": "GPU_WORKER_TOKEN" },
        "capabilities": ["tts", "stt", "realtime"]
      }
    ]
  },
  "database": {
    "backupPath": "/mnt/backup/eidolon"
  }
}
```
