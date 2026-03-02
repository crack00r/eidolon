import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestConfig } from "@eidolon/test-utils";
import { applyEnvOverrides } from "../env.ts";

describe("applyEnvOverrides", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys: string[] = [];

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    envKeys.push(key);
    process.env[key] = value;
  }

  beforeEach(() => {
    envKeys.length = 0;
  });

  afterEach(() => {
    for (const key of envKeys) {
      const original = savedEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  test("EIDOLON_LOGGING_LEVEL overrides config.logging.level", () => {
    const config = createTestConfig();
    setEnv("EIDOLON_LOGGING_LEVEL", "debug");

    const result = applyEnvOverrides(config);
    expect(result.logging.level).toBe("debug");
  });

  test("numeric values are coerced correctly", () => {
    const config = createTestConfig();
    setEnv("EIDOLON_GATEWAY_PORT", "9999");

    const result = applyEnvOverrides(config);
    expect(result.gateway.port).toBe(9999);
  });

  test("boolean values are coerced correctly", () => {
    const config = createTestConfig();
    setEnv("EIDOLON_LEARNING_ENABLED", "true");

    const result = applyEnvOverrides(config);
    expect(result.learning.enabled).toBe(true);
  });

  test("unknown env vars with EIDOLON_ prefix but no matching section are ignored", () => {
    const config = createTestConfig();
    setEnv("EIDOLON_NONEXISTENT_FOO", "bar");

    const result = applyEnvOverrides(config);
    // Should not have created a "nonexistent" section -- config unchanged
    expect(result).toEqual(config);
  });

  test("does not mutate original config", () => {
    const config = createTestConfig();
    const original = structuredClone(config);
    setEnv("EIDOLON_LOGGING_LEVEL", "error");

    applyEnvOverrides(config);
    expect(config).toEqual(original);
  });
});
