import { describe, expect, test } from "bun:test";
import type { ClaudeAccount } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { AccountRotation } from "../account-rotation.ts";

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function makeAccount(overrides?: Partial<ClaudeAccount>): ClaudeAccount {
  return {
    type: "api-key",
    name: "test-account",
    credential: "sk-test-000",
    priority: 50,
    enabled: true,
    ...overrides,
  };
}

describe("AccountRotation", () => {
  const logger = createSilentLogger();

  test("selects highest priority account", () => {
    const rotation = new AccountRotation(
      [
        makeAccount({ name: "low", priority: 10 }),
        makeAccount({ name: "high", priority: 90 }),
        makeAccount({ name: "mid", priority: 50 }),
      ],
      logger,
    );

    const result = rotation.selectAccount();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("high");
  });

  test("skips disabled accounts", () => {
    const rotation = new AccountRotation(
      [
        makeAccount({ name: "disabled", priority: 100, enabled: false }),
        makeAccount({ name: "enabled", priority: 10, enabled: true }),
      ],
      logger,
    );

    const result = rotation.selectAccount();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("enabled");
  });

  test("fails over when account exceeds hourly quota", () => {
    const rotation = new AccountRotation(
      [
        makeAccount({
          name: "primary",
          priority: 90,
          maxTokensPerHour: 100,
        }),
        makeAccount({ name: "fallback", priority: 10 }),
      ],
      logger,
    );

    rotation.reportUsage("primary", 100);

    const result = rotation.selectAccount();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("fallback");
  });

  test("reports usage correctly", () => {
    const rotation = new AccountRotation([makeAccount({ name: "a", maxTokensPerHour: 1000 })], logger);

    rotation.reportUsage("a", 300);
    rotation.reportUsage("a", 200);

    const status = rotation.getStatus();
    expect(status[0]?.tokensUsedThisHour).toBe(500);
  });

  test("reports failure and applies cooldown", () => {
    const rotation = new AccountRotation(
      [makeAccount({ name: "a", priority: 90 }), makeAccount({ name: "b", priority: 10 })],
      logger,
    );

    rotation.reportFailure("a", true);

    const status = rotation.getStatus();
    const stateA = status.find((s) => s.name === "a");
    expect(stateA?.consecutiveFailures).toBe(1);
    expect(stateA?.available).toBe(false);

    // Should select b since a is in cooldown
    const result = rotation.selectAccount();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("b");
  });

  test("returns CLAUDE_RATE_LIMITED when all accounts exhausted", () => {
    const rotation = new AccountRotation([makeAccount({ name: "only", maxTokensPerHour: 10 })], logger);

    rotation.reportUsage("only", 10);

    const result = rotation.selectAccount();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CLAUDE_RATE_LIMITED");
  });

  test("getStatus returns correct availability", () => {
    const rotation = new AccountRotation(
      [makeAccount({ name: "active", enabled: true }), makeAccount({ name: "disabled", enabled: false })],
      logger,
    );

    const status = rotation.getStatus();
    const active = status.find((s) => s.name === "active");
    const disabled = status.find((s) => s.name === "disabled");

    expect(active?.available).toBe(true);
    expect(disabled?.available).toBe(false);
  });

  test("hourly quota resets when hour changes", () => {
    const rotation = new AccountRotation([makeAccount({ name: "a", maxTokensPerHour: 100 })], logger);

    rotation.reportUsage("a", 100);
    expect(rotation.getStatus()[0]?.available).toBe(false);

    // Simulate hour change by setting bucket start to the past
    rotation._setHourBucketStart(Date.now() - 3_600_001);

    const status = rotation.getStatus();
    expect(status[0]?.tokensUsedThisHour).toBe(0);
    expect(status[0]?.available).toBe(true);
  });

  test("sorts by priority then failures then remaining quota", () => {
    const rotation = new AccountRotation(
      [
        makeAccount({
          name: "same-prio-failed",
          priority: 50,
          maxTokensPerHour: 1000,
        }),
        makeAccount({
          name: "same-prio-ok",
          priority: 50,
          maxTokensPerHour: 1000,
        }),
        makeAccount({ name: "high-prio", priority: 90 }),
      ],
      logger,
    );

    // Give same-prio-failed a failure (non-rate-limit, so no cooldown)
    rotation.reportFailure("same-prio-failed", false);

    // High priority should win
    const first = rotation.selectAccount();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.name).toBe("high-prio");

    // Among equal priority, fewer failures wins
    // Disable high-prio to test the tiebreaker
    const rotation2 = new AccountRotation(
      [
        makeAccount({
          name: "failed",
          priority: 50,
          maxTokensPerHour: 1000,
        }),
        makeAccount({
          name: "clean",
          priority: 50,
          maxTokensPerHour: 1000,
        }),
      ],
      logger,
    );

    rotation2.reportFailure("failed", false);

    const result = rotation2.selectAccount();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("clean");
  });

  test("reportUsage resets failure counters", () => {
    const rotation = new AccountRotation([makeAccount({ name: "a" })], logger);

    rotation.reportFailure("a", false);
    rotation.reportFailure("a", false);
    expect(rotation.getStatus()[0]?.consecutiveFailures).toBe(2);

    rotation.reportUsage("a", 10);
    expect(rotation.getStatus()[0]?.consecutiveFailures).toBe(0);
  });

  test("non-rate-limit failure increments failures without cooldown", () => {
    const rotation = new AccountRotation([makeAccount({ name: "a" })], logger);

    rotation.reportFailure("a", false);

    const status = rotation.getStatus();
    expect(status[0]?.consecutiveFailures).toBe(1);
    expect(status[0]?.available).toBe(true);
  });
});
