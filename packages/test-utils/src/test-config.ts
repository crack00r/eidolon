/**
 * Factory for creating valid EidolonConfig instances in tests.
 */

import type { EidolonConfig } from "@eidolon/protocol";
import { EidolonConfigSchema } from "@eidolon/protocol";

/**
 * Create a valid EidolonConfig for testing with sensible defaults.
 * Override any field by passing a partial config.
 */
export function createTestConfig(overrides?: Record<string, unknown>): EidolonConfig {
  const base: Record<string, unknown> = {
    identity: {
      name: "TestEidolon",
      ownerName: "TestUser",
    },
    brain: {
      accounts: [
        {
          type: "api-key" as const,
          name: "test-account",
          credential: "sk-test-fake-key-000000000000000000000",
          priority: 100,
          enabled: true,
        },
      ],
      model: {},
      session: {},
    },
    loop: {
      energyBudget: { categories: {} },
      rest: {},
      businessHours: {},
    },
    memory: {
      extraction: {},
      dreaming: {},
      search: {},
      embedding: {},
      retention: {},
      entityResolution: {},
    },
    learning: { relevance: {}, autoImplement: {}, budget: {} },
    channels: {},
    gateway: { auth: { type: "none" as const } },
    gpu: { tts: {}, stt: {}, fallback: {} },
    security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
    database: {},
    logging: {},
    daemon: {},
  };

  const merged = overrides ? deepMerge(base, overrides) : base;
  return EidolonConfigSchema.parse(merged);
}

/** Simple deep merge for test config overrides. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}
