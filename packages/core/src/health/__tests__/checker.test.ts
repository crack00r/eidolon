import { describe, expect, test } from "bun:test";
import type { HealthCheck } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { HealthChecker } from "../checker.ts";

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

function passCheck(name: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => ({ name, status: "pass" });
}

function warnCheck(name: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => ({ name, status: "warn", message: "degraded" });
}

function failCheck(name: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => ({ name, status: "fail", message: "down" });
}

describe("HealthChecker", () => {
  const logger = createSilentLogger();

  test("all passing checks -> healthy", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", passCheck("db"));
    checker.register("api", passCheck("api"));

    const result = await checker.check();
    expect(result.status).toBe("healthy");
    expect(result.checks).toHaveLength(2);
  });

  test("one warning -> degraded", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", passCheck("db"));
    checker.register("disk", warnCheck("disk"));

    const result = await checker.check();
    expect(result.status).toBe("degraded");
  });

  test("one failure -> unhealthy", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", failCheck("db"));
    checker.register("api", passCheck("api"));

    const result = await checker.check();
    expect(result.status).toBe("unhealthy");
  });

  test("exception in check -> treated as fail", async () => {
    const checker = new HealthChecker(logger);
    checker.register("broken", async () => {
      throw new Error("oops");
    });

    const result = await checker.check();
    expect(result.status).toBe("unhealthy");
    expect(result.checks[0]?.status).toBe("fail");
  });
});
