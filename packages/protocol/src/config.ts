/**
 * Master configuration Zod schema for Eidolon.
 * Every configurable value has a sensible default.
 * Secret references use { "$secret": "KEY_NAME" } syntax.
 *
 * Split into sub-modules:
 *   - config-base.ts      -- SecretRefSchema, stringOrSecret
 *   - config-brain.ts     -- brain, loop, memory, learning
 *   - config-channels.ts  -- channels, gateway, GPU
 *   - config-services.ts  -- HA, security, DB, logging, privacy, etc.
 */

import { z } from "zod";
import { AnticipationConfigSchema } from "./config-anticipation.ts";
import {
  BrainConfigSchema,
  type ClaudeAccountSchema,
  LearningConfigSchema,
  LoopConfigSchema,
  MemoryConfigSchema,
} from "./config-brain.ts";
import {
  ChannelConfigSchema,
  type EmailConfigSchema,
  GatewayConfigSchema,
  GpuConfigSchema,
  type GpuPoolSchema,
  type GpuWorkerSchema,
  type SlackConfigSchema,
  type WebhookEndpointSchema,
  type WhatsAppConfigSchema,
} from "./config-channels.ts";
import {
  BrowserConfigSchema,
  DaemonConfigSchema,
  DatabaseConfigSchema,
  DigestConfigSchema,
  HomeAutomationConfigSchema,
  LLMConfigSchema,
  type LlamaCppProviderSchema,
  LoggingConfigSchema,
  type OllamaProviderSchema,
  PluginConfigSchema,
  PrivacyConfigSchema,
  ReplicationConfigSchema,
  SecurityConfigSchema,
  TelemetryConfigSchema,
  UsersConfigSchema,
} from "./config-services.ts";
import { CalendarConfigSchema } from "./types/calendar.ts";

// ---------------------------------------------------------------------------
// Re-exports from config-base and config-anticipation
// ---------------------------------------------------------------------------

export type { AnticipationConfig } from "./config-anticipation.ts";
export { AnticipationConfigSchema } from "./config-anticipation.ts";
export type { SecretRef } from "./config-base.ts";
export { SecretRefSchema, stringOrSecret } from "./config-base.ts";

// ---------------------------------------------------------------------------
// Re-exports from sub-modules
// ---------------------------------------------------------------------------

export {
  BrainConfigSchema,
  ClaudeAccountSchema,
  LearningConfigSchema,
  LoopConfigSchema,
  MemoryConfigSchema,
} from "./config-brain.ts";
export {
  ChannelConfigSchema,
  EmailConfigSchema,
  GatewayConfigSchema,
  GpuConfigSchema,
  GpuPoolSchema,
  GpuWorkerSchema,
  SlackConfigSchema,
  WebhookEndpointSchema,
  WhatsAppConfigSchema,
} from "./config-channels.ts";
export {
  BrowserConfigSchema,
  DaemonConfigSchema,
  DatabaseConfigSchema,
  DigestConfigSchema,
  HAAnomalyRuleSchema,
  HADomainPolicySchema,
  HASceneActionConfigSchema,
  HASceneConfigSchema,
  HomeAutomationConfigSchema,
  LLMConfigSchema,
  LlamaCppProviderSchema,
  LoggingConfigSchema,
  OllamaProviderSchema,
  PluginConfigSchema,
  PrivacyConfigSchema,
  ReplicationConfigSchema,
  SecurityConfigSchema,
  TelemetryConfigSchema,
  UsersConfigSchema,
} from "./config-services.ts";

// ---------------------------------------------------------------------------
// Master Config
// ---------------------------------------------------------------------------

export const EidolonRoleSchema = z.enum(["server", "client"]);
export type EidolonRole = z.infer<typeof EidolonRoleSchema>;

export const ServerConnectionSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).default(8419),
  token: z.string().optional(),
  tls: z.boolean().default(false),
});

export const EidolonConfigSchema = z.object({
  identity: z.object({
    name: z.string().default("Eidolon"),
    ownerName: z.string(),
  }),
  role: EidolonRoleSchema.default("server"),
  server: ServerConnectionSchema.optional(),
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
  anticipation: AnticipationConfigSchema.default({}),
  calendar: CalendarConfigSchema.default({}),
  homeAutomation: HomeAutomationConfigSchema.default({}),
  database: DatabaseConfigSchema,
  logging: LoggingConfigSchema,
  telemetry: TelemetryConfigSchema.default({}),
  plugins: PluginConfigSchema.default({}),
  llm: LLMConfigSchema.default({}),
  browser: BrowserConfigSchema.default({}),
  replication: ReplicationConfigSchema.default({}),
  users: UsersConfigSchema,
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
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
export type CalendarConfigInferred = z.infer<typeof CalendarConfigSchema>;
export type HomeAutomationConfig = z.infer<typeof HomeAutomationConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type OllamaProviderConfig = z.infer<typeof OllamaProviderSchema>;
export type LlamaCppProviderConfig = z.infer<typeof LlamaCppProviderSchema>;
export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;
export type WebhookEndpointConfig = z.infer<typeof WebhookEndpointSchema>;
export type SlackConfig = z.infer<typeof SlackConfigSchema>;
export type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type ReplicationConfig = z.infer<typeof ReplicationConfigSchema>;
export type UsersConfig = z.infer<typeof UsersConfigSchema>;
