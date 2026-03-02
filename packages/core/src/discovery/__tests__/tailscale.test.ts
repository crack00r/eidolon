import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { TailscaleDetector } from "../tailscale.ts";

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

describe("TailscaleDetector", () => {
  const logger = createSilentLogger();

  test("getCachedIp returns undefined before poll", () => {
    const detector = new TailscaleDetector(logger);
    expect(detector.getCachedIp()).toBeUndefined();
  });

  test("getInfo returns a Result", async () => {
    const detector = new TailscaleDetector(logger);
    const result = await detector.getInfo();

    // Should succeed regardless of whether Tailscale is installed
    // because the detector gracefully handles missing Tailscale
    if (result.ok) {
      expect(typeof result.value.active).toBe("boolean");
      expect(typeof result.value.ip).toBe("string");
      expect(typeof result.value.hostname).toBe("string");
    } else {
      // Error case: Tailscale not installed
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  test("start and stop do not throw", () => {
    const detector = new TailscaleDetector(logger);
    expect(() => detector.start()).not.toThrow();
    expect(() => detector.stop()).not.toThrow();
  });

  test("stop is idempotent", () => {
    const detector = new TailscaleDetector(logger);
    detector.start();
    expect(() => detector.stop()).not.toThrow();
    expect(() => detector.stop()).not.toThrow();
  });
});
