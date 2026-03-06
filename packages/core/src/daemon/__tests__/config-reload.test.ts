/**
 * Tests for hot-reload config change handler.
 *
 * Verifies that:
 * - Hot-reloadable sections propagate to modules
 * - Non-hot-reloadable changes produce warnings
 * - EnergyBudget and RestCalculator receive updated configs
 */

import { describe, expect, test } from "bun:test";
import type { EidolonConfig } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { EnergyBudget } from "../../loop/energy-budget.ts";
import { RestCalculator } from "../../loop/rest.ts";
import { buildConfigReloadHandler } from "../config-reload.ts";
import type { InitializedModules } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogRecord {
  level: string;
  module: string;
  message: string;
}

function createCapturingLogger(): { logger: Logger; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const logger: Logger = {
    debug: (module: string, message: string) => {
      logs.push({ level: "debug", module, message });
    },
    info: (module: string, message: string) => {
      logs.push({ level: "info", module, message });
    },
    warn: (module: string, message: string) => {
      logs.push({ level: "warn", module, message });
    },
    error: (module: string, message: string) => {
      logs.push({ level: "error", module, message });
    },
    child: () => logger,
  };
  return { logger, logs };
}

/** Create a minimal valid EidolonConfig for testing. */
function createTestConfig(overrides?: Partial<EidolonConfig>): EidolonConfig {
  const base: EidolonConfig = {
    identity: { name: "Eidolon", ownerName: "Test" },
    brain: {
      accounts: [
        { type: "oauth" as const, name: "test", credential: "oauth", priority: 50, enabled: true },
      ],
      model: {
        default: "claude-sonnet-4-20250514",
        complex: "claude-opus-4-20250514",
        fast: "claude-haiku-3-20250414",
      },
      session: { maxTurns: 50, compactAfter: 40, timeoutMs: 300_000 },
    },
    loop: {
      energyBudget: {
        maxTokensPerHour: 100_000,
        categories: { user: 0.5, tasks: 0.2, learning: 0.2, dreaming: 0.1 },
      },
      rest: {
        activeMinMs: 2_000,
        idleMinMs: 30_000,
        maxMs: 300_000,
        nightModeStartHour: 23,
        nightModeEndHour: 7,
        nightModeMultiplier: 3,
      },
      businessHours: { start: "07:00", end: "23:00", timezone: "Europe/Berlin" },
    },
    memory: {
      extraction: { strategy: "hybrid" as const, minConfidence: 0.7 },
      dreaming: { enabled: true, schedule: "02:00", maxDurationMinutes: 30 },
      search: { maxResults: 20, rrfK: 60, bm25Weight: 0.4, vectorWeight: 0.4, graphWeight: 0.2 },
      embedding: { model: "Xenova/multilingual-e5-small", dimensions: 384, batchSize: 32 },
      retention: { shortTermDays: 90, decayRate: 0.01 },
      entityResolution: { personThreshold: 0.95, technologyThreshold: 0.9, conceptThreshold: 0.85 },
    },
    learning: {
      enabled: false,
      sources: [],
      relevance: { minScore: 0.6, userInterests: [] },
      autoImplement: { enabled: false, requireApproval: true, allowedScopes: [] },
      budget: { maxTokensPerDay: 50_000, maxDiscoveriesPerDay: 20 },
    },
    channels: {},
    gateway: {
      host: "127.0.0.1",
      port: 8419,
      auth: { type: "none" as const },
      maxMessageBytes: 1_048_576,
      maxClients: 10,
      allowedOrigins: [],
      rateLimiting: { maxFailures: 5, windowMs: 60_000, blockMs: 300_000, maxBlockMs: 3_600_000 },
    },
    gpu: {
      workers: [],
      tts: { model: "Qwen/Qwen3-TTS-1.7B", defaultSpeaker: "Chelsie", sampleRate: 24_000 },
      stt: { model: "large-v3", language: "auto" },
      fallback: { cpuTts: true, systemTts: true },
    },
    security: {
      policies: {
        shellExecution: "needs_approval" as const,
        fileModification: "needs_approval" as const,
        networkAccess: "safe" as const,
        secretAccess: "dangerous" as const,
      },
      approval: { timeout: 300_000, defaultAction: "deny" as const },
      sandbox: { enabled: false, runtime: "none" as const },
      audit: { enabled: true, retentionDays: 365 },
    },
    database: { directory: "", walMode: true, backupSchedule: "0 3 * * *" },
    logging: { level: "info" as const, format: "json" as const, directory: "", maxSizeMb: 50, maxFiles: 10 },
    daemon: { pidFile: "", gracefulShutdownMs: 10_000 },
  } as unknown as EidolonConfig;

  return { ...base, ...overrides } as EidolonConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildConfigReloadHandler", () => {
  test("propagates energyBudget changes to EnergyBudget module", () => {
    const { logger } = createCapturingLogger();
    const oldConfig = createTestConfig();

    const energyBudget = new EnergyBudget(oldConfig.loop.energyBudget, logger);
    const modules: InitializedModules = {
      logger,
      config: oldConfig,
      energyBudget,
    };

    const handler = buildConfigReloadHandler(modules, logger);

    // Change energyBudget maxTokensPerHour
    const newConfig = createTestConfig({
      loop: {
        ...oldConfig.loop,
        energyBudget: {
          ...oldConfig.loop.energyBudget,
          maxTokensPerHour: 200_000,
        },
      },
    } as Partial<EidolonConfig>);

    handler(newConfig);

    // Verify modules.config was updated
    expect(modules.config).toBe(newConfig);

    // Verify EnergyBudget reflects new config via remaining()
    // With 200_000 max and 0.2 tasks allocation = 40_000 remaining for tasks
    const remaining = energyBudget.remaining("tasks");
    expect(remaining).toBe(40_000);
  });

  test("propagates rest changes to RestCalculator module", () => {
    const { logger } = createCapturingLogger();
    const oldConfig = createTestConfig();

    const restCalculator = new RestCalculator(oldConfig.loop.rest, logger);
    const modules: InitializedModules = {
      logger,
      config: oldConfig,
      restCalculator,
    };

    const handler = buildConfigReloadHandler(modules, logger);

    // Change rest activeMinMs
    const newConfig = createTestConfig({
      loop: {
        ...oldConfig.loop,
        rest: {
          ...oldConfig.loop.rest,
          activeMinMs: 5_000,
          maxMs: 600_000,
        },
      },
    } as Partial<EidolonConfig>);

    handler(newConfig);

    // Verify RestCalculator uses new config
    const duration = restCalculator.calculate({
      lastUserActivityAt: Date.now() - 1000, // very recent
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: false,
    });
    // With activeMinMs: 5_000 and user active within 10 seconds
    expect(duration).toBe(5_000);
  });

  test("warns about non-hot-reloadable section changes", () => {
    const { logger, logs } = createCapturingLogger();
    const oldConfig = createTestConfig();
    const modules: InitializedModules = {
      logger,
      config: oldConfig,
    };

    const handler = buildConfigReloadHandler(modules, logger);

    // Change gateway (non-hot-reloadable)
    const newConfig = createTestConfig({
      gateway: {
        ...oldConfig.gateway,
        port: 9999,
      },
    } as Partial<EidolonConfig>);

    handler(newConfig);

    // Should have a warning about gateway needing restart
    const warnings = logs.filter((l) => l.level === "warn" && l.module === "config-reload");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.message.includes("restart"))).toBe(true);
  });

  test("does nothing when no sections changed", () => {
    const { logger, logs } = createCapturingLogger();
    const config = createTestConfig();
    const modules: InitializedModules = {
      logger,
      config,
    };

    const handler = buildConfigReloadHandler(modules, logger);

    // Same config
    const sameConfig = createTestConfig();
    handler(sameConfig);

    // Should log "no sections differ"
    const debugLogs = logs.filter((l) => l.level === "debug" && l.module === "config-reload");
    expect(debugLogs.some((l) => l.message.includes("no sections differ"))).toBe(true);
  });

  test("updates modules.config reference on any change", () => {
    const { logger } = createCapturingLogger();
    const oldConfig = createTestConfig();
    const modules: InitializedModules = {
      logger,
      config: oldConfig,
    };

    const handler = buildConfigReloadHandler(modules, logger);

    const newConfig = createTestConfig({
      identity: { name: "NewName", ownerName: "Test" },
    } as Partial<EidolonConfig>);

    handler(newConfig);
    expect(modules.config).toBe(newConfig);
  });

  test("handles first config load when modules.config is undefined", () => {
    const { logger, logs } = createCapturingLogger();
    const modules: InitializedModules = {
      logger,
    };

    const handler = buildConfigReloadHandler(modules, logger);
    const config = createTestConfig();

    handler(config);
    expect(modules.config).toBe(config);
    // Should not produce any warnings (first load)
    const warnings = logs.filter((l) => l.level === "warn");
    expect(warnings.length).toBe(0);
  });

  test("calls setLevel on logger when logging.level changes", () => {
    const { logger, logs } = createCapturingLogger();
    let capturedLevel: string | undefined;
    logger.setLevel = (level: string) => {
      capturedLevel = level;
    };
    const oldConfig = createTestConfig();
    const modules: InitializedModules = {
      logger,
      config: oldConfig,
    };

    const handler = buildConfigReloadHandler(modules, logger);

    const newConfig = createTestConfig({
      logging: { ...oldConfig.logging, level: "debug" as const },
    } as Partial<EidolonConfig>);

    handler(newConfig);

    // setLevel was called with the new level
    expect(capturedLevel).toBe("debug");

    const infoLogs = logs.filter(
      (l) => l.level === "info" && l.module === "config-reload" && l.message.includes("Log level changed"),
    );
    expect(infoLogs.length).toBe(1);
    expect(infoLogs[0]?.message).toContain("info -> debug");
  });

  test("falls back gracefully when logger has no setLevel", () => {
    const { logger, logs } = createCapturingLogger();
    // Ensure no setLevel method
    delete (logger as unknown as Record<string, unknown>).setLevel;
    const oldConfig = createTestConfig();
    const modules: InitializedModules = {
      logger,
      config: oldConfig,
    };

    const handler = buildConfigReloadHandler(modules, logger);

    const newConfig = createTestConfig({
      logging: { ...oldConfig.logging, level: "debug" as const },
    } as Partial<EidolonConfig>);

    handler(newConfig);

    const infoLogs = logs.filter(
      (l) => l.level === "info" && l.module === "config-reload" && l.message.includes("Log level changed"),
    );
    expect(infoLogs.length).toBe(1);
    expect(infoLogs[0]?.message).toContain("restart required");
  });
});
