import { describe, expect, test } from "bun:test";
import {
  BrainConfigSchema,
  ChannelConfigSchema,
  ClaudeAccountSchema,
  DaemonConfigSchema,
  DatabaseConfigSchema,
  EidolonConfigSchema,
  GatewayConfigSchema,
  GpuConfigSchema,
  LearningConfigSchema,
  LoggingConfigSchema,
  LoopConfigSchema,
  MemoryConfigSchema,
  SecretRefSchema,
  SecurityConfigSchema,
} from "../config.ts";

// ---------------------------------------------------------------------------
// Helpers -- minimal valid inputs for each schema
// ---------------------------------------------------------------------------

/** Minimal valid BrainConfig input (nested objects required, fields default). */
function minimalBrain(): Record<string, unknown> {
  return {
    accounts: [{ type: "api-key", name: "main", credential: "sk-key" }],
    model: {},
    session: {},
  };
}

/** Minimal valid LoopConfig input. */
function minimalLoop(): Record<string, unknown> {
  return {
    energyBudget: { categories: {} },
    rest: {},
    businessHours: {},
  };
}

/** Minimal valid MemoryConfig input. */
function minimalMemory(): Record<string, unknown> {
  return {
    extraction: {},
    dreaming: {},
    search: {},
    embedding: {},
    retention: {},
    entityResolution: {},
  };
}

/** Minimal valid LearningConfig input. */
function minimalLearning(): Record<string, unknown> {
  return {
    relevance: {},
    autoImplement: {},
    budget: {},
  };
}

/** Minimal valid GpuConfig input. */
function minimalGpu(): Record<string, unknown> {
  return {
    tts: {},
    stt: {},
    fallback: {},
  };
}

/** Minimal valid SecurityConfig input. */
function minimalSecurity(): Record<string, unknown> {
  return {
    policies: {},
    approval: {},
    sandbox: {},
    audit: {},
  };
}

/** Minimal valid master config with all required nested objects. */
function minimalValidConfig(): Record<string, unknown> {
  return {
    identity: { name: "TestEidolon", ownerName: "Tester" },
    brain: minimalBrain(),
    loop: minimalLoop(),
    memory: minimalMemory(),
    learning: minimalLearning(),
    channels: {},
    gateway: { auth: { type: "none" } },
    gpu: minimalGpu(),
    security: minimalSecurity(),
    database: {},
    logging: {},
    daemon: {},
  };
}

// ---------------------------------------------------------------------------
// EidolonConfigSchema: Full config
// ---------------------------------------------------------------------------

describe("EidolonConfigSchema", () => {
  test("minimal valid config passes", () => {
    const result = EidolonConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
  });

  test("missing identity.ownerName fails", () => {
    const config = minimalValidConfig();
    (config as Record<string, unknown>).identity = { name: "Test" };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("missing brain section fails", () => {
    const config = minimalValidConfig();
    delete (config as Record<string, unknown>).brain;
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("completely empty object fails", () => {
    const result = EidolonConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("non-object input fails", () => {
    expect(EidolonConfigSchema.safeParse("string").success).toBe(false);
    expect(EidolonConfigSchema.safeParse(42).success).toBe(false);
    expect(EidolonConfigSchema.safeParse(null).success).toBe(false);
  });

  test("defaults are populated for optional fields", () => {
    const result = EidolonConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
    if (!result.success) return;

    const config = result.data;
    expect(config.identity.name).toBe("TestEidolon");
    expect(config.logging.level).toBe("info");
    expect(config.logging.format).toBe("json");
    expect(config.database.walMode).toBe(true);
    expect(config.daemon.gracefulShutdownMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// SecretRefSchema
// ---------------------------------------------------------------------------

describe("SecretRefSchema", () => {
  test("valid secret reference", () => {
    const result = SecretRefSchema.safeParse({ $secret: "API_KEY" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.$secret).toBe("API_KEY");
  });

  test("missing $secret key fails", () => {
    const result = SecretRefSchema.safeParse({ key: "API_KEY" });
    expect(result.success).toBe(false);
  });

  test("non-string $secret value fails", () => {
    const result = SecretRefSchema.safeParse({ $secret: 123 });
    expect(result.success).toBe(false);
  });

  test("empty object fails", () => {
    const result = SecretRefSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BrainConfigSchema
// ---------------------------------------------------------------------------

describe("BrainConfigSchema", () => {
  test("valid brain config with single account", () => {
    const result = BrainConfigSchema.safeParse(minimalBrain());
    expect(result.success).toBe(true);
  });

  test("account credential can be a secret reference", () => {
    const result = BrainConfigSchema.safeParse({
      accounts: [{ type: "oauth", name: "main", credential: { $secret: "OAUTH_TOKEN" } }],
      model: {},
      session: {},
    });
    expect(result.success).toBe(true);
  });

  test("empty accounts array fails", () => {
    const result = BrainConfigSchema.safeParse({ accounts: [], model: {}, session: {} });
    expect(result.success).toBe(false);
  });

  test("invalid account type fails", () => {
    const result = BrainConfigSchema.safeParse({
      accounts: [{ type: "invalid", name: "main", credential: "key" }],
      model: {},
      session: {},
    });
    expect(result.success).toBe(false);
  });

  test("missing model or session section fails", () => {
    const noModel = BrainConfigSchema.safeParse({
      accounts: [{ type: "api-key", name: "a", credential: "k" }],
      session: {},
    });
    expect(noModel.success).toBe(false);

    const noSession = BrainConfigSchema.safeParse({
      accounts: [{ type: "api-key", name: "a", credential: "k" }],
      model: {},
    });
    expect(noSession.success).toBe(false);
  });

  test("account priority bounds (1-100)", () => {
    const valid = BrainConfigSchema.safeParse({
      accounts: [{ type: "api-key", name: "a", credential: "k", priority: 1 }],
      model: {},
      session: {},
    });
    expect(valid.success).toBe(true);

    const tooLow = BrainConfigSchema.safeParse({
      accounts: [{ type: "api-key", name: "a", credential: "k", priority: 0 }],
      model: {},
      session: {},
    });
    expect(tooLow.success).toBe(false);

    const tooHigh = BrainConfigSchema.safeParse({
      accounts: [{ type: "api-key", name: "a", credential: "k", priority: 101 }],
      model: {},
      session: {},
    });
    expect(tooHigh.success).toBe(false);
  });

  test("default model names are set", () => {
    const result = BrainConfigSchema.safeParse(minimalBrain());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.model.default).toBe("claude-sonnet-4-20250514");
    expect(result.data.model.complex).toBe("claude-opus-4-20250514");
    expect(result.data.model.fast).toBe("claude-haiku-3-20250414");
  });

  test("session defaults are set", () => {
    const result = BrainConfigSchema.safeParse(minimalBrain());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.session.maxTurns).toBe(50);
    expect(result.data.session.compactAfter).toBe(40);
    expect(result.data.session.timeoutMs).toBe(300_000);
  });

  test("mcpServers optional nested map", () => {
    const result = BrainConfigSchema.safeParse({
      ...minimalBrain(),
      mcpServers: {
        filesystem: {
          command: "mcp-server-filesystem",
          args: ["/home"],
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LoopConfigSchema (includes businessHours validation)
// ---------------------------------------------------------------------------

describe("LoopConfigSchema", () => {
  test("minimal loop config passes", () => {
    const result = LoopConfigSchema.safeParse(minimalLoop());
    expect(result.success).toBe(true);
  });

  test("missing nested objects fails", () => {
    const result = LoopConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("business hours with valid HH:MM format", () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalLoop(),
      businessHours: {
        start: "08:00",
        end: "18:00",
        timezone: "Europe/Berlin",
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.businessHours.start).toBe("08:00");
    expect(result.data.businessHours.end).toBe("18:00");
  });

  test("business hours with invalid format fails", () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalLoop(),
      businessHours: { start: "8am", end: "6pm" },
    });
    expect(result.success).toBe(false);
  });

  test("business hours with invalid hour (24) fails", () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalLoop(),
      businessHours: { start: "24:00", end: "18:00" },
    });
    expect(result.success).toBe(false);
  });

  test("business hours with invalid minute (60) fails", () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalLoop(),
      businessHours: { start: "08:60", end: "18:00" },
    });
    expect(result.success).toBe(false);
  });

  test("business hours defaults are 07:00-23:00 Europe/Berlin", () => {
    const result = LoopConfigSchema.safeParse(minimalLoop());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.businessHours.start).toBe("07:00");
    expect(result.data.businessHours.end).toBe("23:00");
    expect(result.data.businessHours.timezone).toBe("Europe/Berlin");
  });

  test("energy budget categories must be 0-1", () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalLoop(),
      energyBudget: {
        categories: { user: 1.5, tasks: 0.2, learning: 0.2, dreaming: 0.1 },
      },
    });
    expect(result.success).toBe(false);
  });

  test("rest config has correct defaults", () => {
    const result = LoopConfigSchema.safeParse(minimalLoop());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rest.activeMinMs).toBe(2_000);
    expect(result.data.rest.idleMinMs).toBe(30_000);
    expect(result.data.rest.nightModeStartHour).toBe(23);
    expect(result.data.rest.nightModeEndHour).toBe(7);
  });

  test("night mode hours must be 0-23", () => {
    const invalid = LoopConfigSchema.safeParse({
      ...minimalLoop(),
      rest: { nightModeStartHour: 25 },
    });
    expect(invalid.success).toBe(false);
  });

  test("string where number expected fails", () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalLoop(),
      energyBudget: { maxTokensPerHour: "not-a-number", categories: {} },
    });
    expect(result.success).toBe(false);
  });

  test("energyBudget nested defaults", () => {
    const result = LoopConfigSchema.safeParse(minimalLoop());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.energyBudget.maxTokensPerHour).toBe(100_000);
    expect(result.data.energyBudget.categories.user).toBe(0.5);
    expect(result.data.energyBudget.categories.tasks).toBe(0.2);
    expect(result.data.energyBudget.categories.learning).toBe(0.2);
    expect(result.data.energyBudget.categories.dreaming).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// MemoryConfigSchema
// ---------------------------------------------------------------------------

describe("MemoryConfigSchema", () => {
  test("minimal memory config passes", () => {
    const result = MemoryConfigSchema.safeParse(minimalMemory());
    expect(result.success).toBe(true);
  });

  test("missing nested objects fails", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("extraction strategy must be valid enum", () => {
    const valid = MemoryConfigSchema.safeParse({
      ...minimalMemory(),
      extraction: { strategy: "hybrid" },
    });
    expect(valid.success).toBe(true);

    const invalid = MemoryConfigSchema.safeParse({
      ...minimalMemory(),
      extraction: { strategy: "magic" },
    });
    expect(invalid.success).toBe(false);
  });

  test("search weights must be 0-1", () => {
    const invalid = MemoryConfigSchema.safeParse({
      ...minimalMemory(),
      search: { bm25Weight: 2.0 },
    });
    expect(invalid.success).toBe(false);
  });

  test("embedding defaults", () => {
    const result = MemoryConfigSchema.safeParse(minimalMemory());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.embedding.model).toBe("Xenova/multilingual-e5-small");
    expect(result.data.embedding.dimensions).toBe(384);
  });

  test("minConfidence must be 0-1", () => {
    const invalid = MemoryConfigSchema.safeParse({
      ...minimalMemory(),
      extraction: { minConfidence: -0.1 },
    });
    expect(invalid.success).toBe(false);
  });

  test("entityResolution thresholds must be 0-1", () => {
    const valid = MemoryConfigSchema.safeParse({
      ...minimalMemory(),
      entityResolution: { personThreshold: 0.95 },
    });
    expect(valid.success).toBe(true);

    const invalid = MemoryConfigSchema.safeParse({
      ...minimalMemory(),
      entityResolution: { personThreshold: 1.5 },
    });
    expect(invalid.success).toBe(false);
  });

  test("retention settings defaults", () => {
    const result = MemoryConfigSchema.safeParse(minimalMemory());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.retention.shortTermDays).toBe(90);
    expect(result.data.retention.decayRate).toBe(0.01);
  });
});

// ---------------------------------------------------------------------------
// LearningConfigSchema (includes cron validation)
// ---------------------------------------------------------------------------

describe("LearningConfigSchema", () => {
  test("minimal learning config passes", () => {
    const result = LearningConfigSchema.safeParse(minimalLearning());
    expect(result.success).toBe(true);
  });

  test("missing nested objects fails", () => {
    const result = LearningConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("valid learning source types", () => {
    const validTypes = ["reddit", "hackernews", "github", "rss", "arxiv"];
    for (const type of validTypes) {
      const result = LearningConfigSchema.safeParse({
        ...minimalLearning(),
        sources: [{ type, config: {}, schedule: "0 * * * *" }],
      });
      expect(result.success).toBe(true);
    }
  });

  test("invalid learning source type fails", () => {
    const result = LearningConfigSchema.safeParse({
      ...minimalLearning(),
      sources: [{ type: "twitter", config: {}, schedule: "0 * * * *" }],
    });
    expect(result.success).toBe(false);
  });

  test("valid cron expression passes", () => {
    const result = LearningConfigSchema.safeParse({
      ...minimalLearning(),
      sources: [{ type: "reddit", config: {}, schedule: "0 3 * * *" }],
    });
    expect(result.success).toBe(true);
  });

  test("invalid cron expression fails", () => {
    const result = LearningConfigSchema.safeParse({
      ...minimalLearning(),
      sources: [{ type: "reddit", config: {}, schedule: "not a cron" }],
    });
    expect(result.success).toBe(false);
  });

  test("cron expression with 6 fields fails (only 5 supported)", () => {
    const result = LearningConfigSchema.safeParse({
      ...minimalLearning(),
      sources: [{ type: "reddit", config: {}, schedule: "0 0 * * * *" }],
    });
    expect(result.success).toBe(false);
  });

  test("cron with step values passes (*/N notation)", () => {
    const expressions = ["*/6 * * * *", "0 */2 * * *", "*/15 * * * 1-5"];
    for (const schedule of expressions) {
      const result = LearningConfigSchema.safeParse({
        ...minimalLearning(),
        sources: [{ type: "reddit", config: {}, schedule }],
      });
      expect(result.success).toBe(true);
    }
  });

  test("learning budget defaults", () => {
    const result = LearningConfigSchema.safeParse(minimalLearning());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.budget.maxTokensPerDay).toBe(50_000);
    expect(result.data.budget.maxDiscoveriesPerDay).toBe(20);
  });

  test("autoImplement defaults to disabled with approval required", () => {
    const result = LearningConfigSchema.safeParse(minimalLearning());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.autoImplement.enabled).toBe(false);
    expect(result.data.autoImplement.requireApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ChannelConfigSchema
// ---------------------------------------------------------------------------

describe("ChannelConfigSchema", () => {
  test("empty channels config passes", () => {
    const result = ChannelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("telegram with secret token", () => {
    const result = ChannelConfigSchema.safeParse({
      telegram: {
        enabled: true,
        botToken: { $secret: "TELEGRAM_BOT_TOKEN" },
        allowedUserIds: [123456],
      },
    });
    expect(result.success).toBe(true);
  });

  test("telegram with plain string token", () => {
    const result = ChannelConfigSchema.safeParse({
      telegram: {
        enabled: false,
        botToken: "plain-token-value",
        allowedUserIds: [123],
      },
    });
    expect(result.success).toBe(true);
  });

  test("telegram missing allowedUserIds fails", () => {
    const result = ChannelConfigSchema.safeParse({
      telegram: {
        enabled: true,
        botToken: "token",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GatewayConfigSchema
// ---------------------------------------------------------------------------

describe("GatewayConfigSchema", () => {
  test("gateway with token auth", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "token", token: "secret-token" },
    });
    expect(result.success).toBe(true);
  });

  test("gateway with token auth but missing token fails", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "token" },
    });
    expect(result.success).toBe(false);
  });

  test("gateway with no auth passes", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "none" },
    });
    expect(result.success).toBe(true);
  });

  test("TLS requires cert and key when enabled", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "none" },
      tls: { enabled: true },
    });
    expect(result.success).toBe(false);
  });

  test("TLS with cert and key passes", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "none" },
      tls: { enabled: true, cert: "/path/cert.pem", key: "/path/key.pem" },
    });
    expect(result.success).toBe(true);
  });

  test("gateway defaults", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "none" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.host).toBe("127.0.0.1");
    expect(result.data.port).toBe(8419);
    expect(result.data.maxMessageBytes).toBe(1_048_576);
    expect(result.data.maxClients).toBe(10);
  });

  test("rate limiting defaults", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "none" },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.rateLimiting.maxFailures).toBe(5);
    expect(result.data.rateLimiting.windowMs).toBe(60_000);
  });

  test("token can be a secret reference", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "token", token: { $secret: "GATEWAY_TOKEN" } },
    });
    expect(result.success).toBe(true);
  });

  test("negative rateLimiting values fail", () => {
    const invalid = GatewayConfigSchema.safeParse({
      auth: { type: "none" },
      rateLimiting: { maxFailures: -1 },
    });
    expect(invalid.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GpuConfigSchema
// ---------------------------------------------------------------------------

describe("GpuConfigSchema", () => {
  test("minimal gpu config passes", () => {
    const result = GpuConfigSchema.safeParse(minimalGpu());
    expect(result.success).toBe(true);
  });

  test("missing nested objects fails", () => {
    const result = GpuConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("gpu worker with capabilities", () => {
    const result = GpuConfigSchema.safeParse({
      ...minimalGpu(),
      workers: [
        {
          name: "rtx5080",
          host: "192.168.1.100",
          port: 8420,
          token: { $secret: "GPU_TOKEN" },
          capabilities: ["tts", "stt"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("invalid gpu capability fails", () => {
    const result = GpuConfigSchema.safeParse({
      ...minimalGpu(),
      workers: [
        {
          name: "worker",
          host: "localhost",
          token: "token",
          capabilities: ["invalid"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("tts defaults", () => {
    const result = GpuConfigSchema.safeParse(minimalGpu());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tts.model).toBe("Qwen/Qwen3-TTS-1.7B");
    expect(result.data.tts.defaultSpeaker).toBe("Chelsie");
  });
});

// ---------------------------------------------------------------------------
// SecurityConfigSchema
// ---------------------------------------------------------------------------

describe("SecurityConfigSchema", () => {
  test("minimal security config passes", () => {
    const result = SecurityConfigSchema.safeParse(minimalSecurity());
    expect(result.success).toBe(true);
  });

  test("missing nested objects fails", () => {
    const result = SecurityConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("policy values must be valid enum", () => {
    const valid = SecurityConfigSchema.safeParse({
      ...minimalSecurity(),
      policies: { shellExecution: "dangerous" },
    });
    expect(valid.success).toBe(true);

    const invalid = SecurityConfigSchema.safeParse({
      ...minimalSecurity(),
      policies: { shellExecution: "invalid" },
    });
    expect(invalid.success).toBe(false);
  });

  test("default policies", () => {
    const result = SecurityConfigSchema.safeParse(minimalSecurity());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.policies.shellExecution).toBe("needs_approval");
    expect(result.data.policies.secretAccess).toBe("dangerous");
    expect(result.data.policies.networkAccess).toBe("safe");
  });

  test("sandbox runtime must be valid enum", () => {
    const valid = SecurityConfigSchema.safeParse({
      ...minimalSecurity(),
      sandbox: { runtime: "docker" },
    });
    expect(valid.success).toBe(true);

    const invalid = SecurityConfigSchema.safeParse({
      ...minimalSecurity(),
      sandbox: { runtime: "kubernetes" },
    });
    expect(invalid.success).toBe(false);
  });

  test("approval nested defaults", () => {
    const result = SecurityConfigSchema.safeParse(minimalSecurity());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.approval.timeout).toBe(300_000);
    expect(result.data.approval.defaultAction).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// DatabaseConfigSchema
// ---------------------------------------------------------------------------

describe("DatabaseConfigSchema", () => {
  test("default database config passes", () => {
    const result = DatabaseConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.walMode).toBe(true);
    expect(result.data.backupSchedule).toBe("0 3 * * *");
  });

  test("walMode boolean validation", () => {
    const valid = DatabaseConfigSchema.safeParse({ walMode: false });
    expect(valid.success).toBe(true);

    const invalid = DatabaseConfigSchema.safeParse({ walMode: "yes" });
    expect(invalid.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LoggingConfigSchema
// ---------------------------------------------------------------------------

describe("LoggingConfigSchema", () => {
  test("default logging config passes", () => {
    const result = LoggingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.level).toBe("info");
    expect(result.data.format).toBe("json");
    expect(result.data.maxSizeMb).toBe(50);
    expect(result.data.maxFiles).toBe(10);
  });

  test("valid log levels", () => {
    for (const level of ["debug", "info", "warn", "error"]) {
      const result = LoggingConfigSchema.safeParse({ level });
      expect(result.success).toBe(true);
    }
  });

  test("invalid log level fails", () => {
    const result = LoggingConfigSchema.safeParse({ level: "verbose" });
    expect(result.success).toBe(false);
  });

  test("invalid format fails", () => {
    const result = LoggingConfigSchema.safeParse({ format: "xml" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DaemonConfigSchema
// ---------------------------------------------------------------------------

describe("DaemonConfigSchema", () => {
  test("default daemon config passes", () => {
    const result = DaemonConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.gracefulShutdownMs).toBe(10_000);
  });

  test("negative gracefulShutdownMs fails", () => {
    const result = DaemonConfigSchema.safeParse({ gracefulShutdownMs: -1 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ClaudeAccountSchema
// ---------------------------------------------------------------------------

describe("ClaudeAccountSchema", () => {
  test("valid api-key account", () => {
    const result = ClaudeAccountSchema.safeParse({
      type: "api-key",
      name: "main",
      credential: "sk-ant-key",
    });
    expect(result.success).toBe(true);
  });

  test("valid oauth account with secret", () => {
    const result = ClaudeAccountSchema.safeParse({
      type: "oauth",
      name: "main",
      credential: { $secret: "OAUTH_TOKEN" },
    });
    expect(result.success).toBe(true);
  });

  test("missing name fails", () => {
    const result = ClaudeAccountSchema.safeParse({
      type: "api-key",
      credential: "sk-key",
    });
    expect(result.success).toBe(false);
  });

  test("missing credential fails", () => {
    const result = ClaudeAccountSchema.safeParse({
      type: "api-key",
      name: "main",
    });
    expect(result.success).toBe(false);
  });

  test("non-integer priority fails", () => {
    const result = ClaudeAccountSchema.safeParse({
      type: "api-key",
      name: "main",
      credential: "key",
      priority: 50.5,
    });
    expect(result.success).toBe(false);
  });

  test("default priority is 50", () => {
    const result = ClaudeAccountSchema.safeParse({
      type: "api-key",
      name: "main",
      credential: "key",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.priority).toBe(50);
  });

  test("default enabled is true", () => {
    const result = ClaudeAccountSchema.safeParse({
      type: "api-key",
      name: "main",
      credential: "key",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Role and Server fields
// ---------------------------------------------------------------------------

describe("Role field", () => {
  test("defaults to server", () => {
    const result = EidolonConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.role).toBe("server");
  });

  test("accepts client role with server block", () => {
    const config = {
      ...minimalValidConfig(),
      role: "client",
      server: { host: "192.168.1.10", port: 8419 },
    };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.role).toBe("client");
    expect(result.data.server?.host).toBe("192.168.1.10");
    expect(result.data.server?.port).toBe(8419);
    expect(result.data.server?.tls).toBe(false);
  });

  test("rejects invalid role", () => {
    const config = { ...minimalValidConfig(), role: "invalid" };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("server block is optional", () => {
    const result = EidolonConfigSchema.safeParse(minimalValidConfig());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.server).toBeUndefined();
  });

  test("server block with token and tls", () => {
    const config = {
      ...minimalValidConfig(),
      role: "client",
      server: { host: "eidolon.local", port: 443, token: "secret-token", tls: true },
    };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.server?.token).toBe("secret-token");
    expect(result.data.server?.tls).toBe(true);
  });

  test("server block rejects invalid port", () => {
    const config = {
      ...minimalValidConfig(),
      server: { host: "localhost", port: 0 },
    };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("server block rejects port above 65535", () => {
    const config = {
      ...minimalValidConfig(),
      server: { host: "localhost", port: 70000 },
    };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("server block defaults port to 8419", () => {
    const config = {
      ...minimalValidConfig(),
      server: { host: "eidolon.local" },
    };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.server?.port).toBe(8419);
  });
});

// ---------------------------------------------------------------------------
// Type coercion edge cases
// ---------------------------------------------------------------------------

describe("Type coercion and edge cases", () => {
  test("string where number expected fails for port", () => {
    const result = GatewayConfigSchema.safeParse({
      auth: { type: "none" },
      port: "not-a-number",
    });
    expect(result.success).toBe(false);
  });

  test("number where string expected fails for log level", () => {
    const result = LoggingConfigSchema.safeParse({ level: 42 });
    expect(result.success).toBe(false);
  });

  test("array where object expected fails", () => {
    const result = MemoryConfigSchema.safeParse({
      ...minimalMemory(),
      extraction: [1, 2, 3],
    });
    expect(result.success).toBe(false);
  });

  test("boolean where string expected fails for identity.name", () => {
    const config = minimalValidConfig();
    (config as Record<string, unknown>).identity = { name: true, ownerName: "Test" };
    const result = EidolonConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
