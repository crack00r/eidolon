/**
 * Channel, gateway, and GPU configuration schemas.
 */

import { z } from "zod";
import { SecretRefSchema, stringOrSecret } from "./config-base.ts";

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const WhatsAppConfigSchema = z.object({
  enabled: z.boolean().default(false),
  phoneNumberId: z.string(),
  businessAccountId: z.string(),
  accessToken: SecretRefSchema.or(z.string()),
  verifyToken: SecretRefSchema.or(z.string()),
  appSecret: SecretRefSchema.or(z.string()),
  allowedPhoneNumbers: z.array(z.string()), // E.164 format
  notifyOnDiscovery: z.boolean().default(true),
  dndSchedule: z
    .object({
      start: z.string().default("22:00"),
      end: z.string().default("07:00"),
    })
    .optional(),
});

export const EmailConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    imap: z.object({
      host: z.string(),
      port: z.number().int().positive().default(993),
      tls: z.boolean().default(true),
      user: z.string(),
      password: SecretRefSchema.or(z.string()),
      pollIntervalMs: z.number().int().positive().default(30_000),
      folder: z.string().default("INBOX"),
    }),
    smtp: z.object({
      host: z.string(),
      port: z.number().int().positive().default(587),
      tls: z.boolean().default(true),
      user: z.string(),
      password: SecretRefSchema.or(z.string()),
      from: z.string(),
    }),
    allowedSenders: z.array(z.string()),
    subjectPrefix: z.string().default("[Eidolon]"),
    maxAttachmentSizeMb: z.number().positive().default(10),
    threadingEnabled: z.boolean().default(true),
  })
  .optional();

export const SlackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: SecretRefSchema.or(z.string()),
  appToken: SecretRefSchema.or(z.string()),
  signingSecret: SecretRefSchema.or(z.string()),
  socketMode: z.boolean().default(true),
  allowedUserIds: z.array(z.string()),
  allowedChannelIds: z.array(z.string()).default([]),
  respondInThread: z.boolean().default(true),
});

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
  slack: SlackConfigSchema.optional(),
  whatsapp: WhatsAppConfigSchema.optional(),
  email: EmailConfigSchema,
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
      type: z.enum(["token", "none"]).default("none"),
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
  token: stringOrSecret(),
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
