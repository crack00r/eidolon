/**
 * Tests for the adaptive rest duration calculator with timezone awareness.
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import type { BusinessHoursConfig } from "../rest.ts";
import { DEFAULT_BUSINESS_HOURS, DEFAULT_REST_CONFIG, RestCalculator } from "../rest.ts";

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

const logger = createSilentLogger();

// ---------------------------------------------------------------------------
// Timezone-aware business hours detection
// ---------------------------------------------------------------------------

describe("RestCalculator timezone-aware business hours", () => {
  test("detects business hours within timezone (UTC)", () => {
    const businessHours: BusinessHoursConfig = {
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    };
    // 12:00 UTC -- should be business hours
    const noonUtc = new Date("2025-06-15T12:00:00Z").getTime();
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger, businessHours, () => noonUtc);

    expect(calc.checkBusinessHours()).toBe(true);
  });

  test("detects outside business hours within timezone (UTC)", () => {
    const businessHours: BusinessHoursConfig = {
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    };
    // 22:00 UTC -- should not be business hours
    const eveningUtc = new Date("2025-06-15T22:00:00Z").getTime();
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger, businessHours, () => eveningUtc);

    expect(calc.checkBusinessHours()).toBe(false);
  });

  test("uses timezone for business hours detection", () => {
    const businessHours: BusinessHoursConfig = {
      start: "07:00",
      end: "23:00",
      timezone: "America/New_York",
    };
    // 10:00 UTC = 06:00 Eastern (before business hours)
    const earlyEastern = new Date("2025-06-15T10:00:00Z").getTime();
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger, businessHours, () => earlyEastern);

    expect(calc.checkBusinessHours()).toBe(false);
  });

  test("auto-detects business hours when isBusinessHours is undefined in context", () => {
    const businessHours: BusinessHoursConfig = {
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    };

    // During business hours
    const noonUtc = new Date("2025-06-15T12:00:00Z").getTime();
    const calcDuring = new RestCalculator(
      { ...DEFAULT_REST_CONFIG, nightModeStartHour: 25, nightModeEndHour: 25, nightModeMultiplier: 1 },
      logger,
      businessHours,
      () => noonUtc,
    );
    const durationDuring = calcDuring.calculate({
      lastUserActivityAt: noonUtc - 600_000, // 10 min ago
      hasPendingEvents: false,
      hasPendingLearning: false,
      // isBusinessHours intentionally omitted -> auto-detect
    });
    expect(durationDuring).toBe(DEFAULT_REST_CONFIG.idleMinMs); // 30s during business hours

    // Outside business hours, no pending work
    const lateUtc = new Date("2025-06-15T23:00:00Z").getTime();
    const calcOutside = new RestCalculator(
      { ...DEFAULT_REST_CONFIG, nightModeStartHour: 25, nightModeEndHour: 25, nightModeMultiplier: 1 },
      logger,
      businessHours,
      () => lateUtc,
    );
    const durationOutside = calcOutside.calculate({
      lastUserActivityAt: lateUtc - 600_000,
      hasPendingEvents: false,
      hasPendingLearning: false,
    });
    expect(durationOutside).toBe(DEFAULT_REST_CONFIG.maxMs); // max rest outside
  });

  test("explicit isBusinessHours in context overrides timezone detection", () => {
    const businessHours: BusinessHoursConfig = {
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    };
    // 12:00 UTC -- would be business hours, but we override
    const noonUtc = new Date("2025-06-15T12:00:00Z").getTime();
    const calc = new RestCalculator(
      { ...DEFAULT_REST_CONFIG, nightModeStartHour: 25, nightModeEndHour: 25, nightModeMultiplier: 1 },
      logger,
      businessHours,
      () => noonUtc,
    );

    // Force NOT business hours even though timezone says it is
    const duration = calc.calculate({
      lastUserActivityAt: noonUtc - 600_000,
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: false,
    });
    // Not business hours + no pending learning -> maxMs
    expect(duration).toBe(DEFAULT_REST_CONFIG.maxMs);
  });
});

// ---------------------------------------------------------------------------
// Night mode with timezone
// ---------------------------------------------------------------------------

describe("RestCalculator night mode timezone awareness", () => {
  test("applies night mode multiplier when in night hours", () => {
    const businessHours: BusinessHoursConfig = {
      start: "07:00",
      end: "23:00",
      timezone: "UTC",
    };
    // 02:00 UTC -- night mode (23-7 range), also outside business hours
    const nightUtc = new Date("2025-06-15T02:00:00Z").getTime();
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger, businessHours, () => nightUtc);

    expect(calc.isNightMode()).toBe(true);

    const duration = calc.calculate({
      lastUserActivityAt: nightUtc - 600_000,
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: false,
    });
    // maxMs would be 300_000, night multiplier would make it 900_000 but capped at maxMs
    expect(duration).toBe(DEFAULT_REST_CONFIG.maxMs);
  });

  test("does not apply night mode during daytime", () => {
    const businessHours: BusinessHoursConfig = {
      start: "07:00",
      end: "23:00",
      timezone: "UTC",
    };
    // 14:00 UTC -- not night mode
    const dayUtc = new Date("2025-06-15T14:00:00Z").getTime();
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger, businessHours, () => dayUtc);

    expect(calc.isNightMode()).toBe(false);
  });

  test("night mode multiplier applies to pending learning rest", () => {
    const config = { ...DEFAULT_REST_CONFIG, nightModeMultiplier: 2 };
    const businessHours: BusinessHoursConfig = {
      start: "07:00",
      end: "20:00",
      timezone: "UTC",
    };
    // 23:30 UTC -- night mode active (23-7)
    const nightUtc = new Date("2025-06-15T23:30:00Z").getTime();
    const calc = new RestCalculator(config, logger, businessHours, () => nightUtc);

    const duration = calc.calculate({
      lastUserActivityAt: nightUtc - 600_000,
      hasPendingEvents: false,
      hasPendingLearning: true,
      isBusinessHours: false,
    });
    // 60_000 * 2 = 120_000 (within maxMs of 300_000)
    expect(duration).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// updateConfig with business hours
// ---------------------------------------------------------------------------

describe("RestCalculator updateConfig", () => {
  test("updateConfig changes business hours", () => {
    const calc = new RestCalculator(
      DEFAULT_REST_CONFIG,
      logger,
      { start: "09:00", end: "17:00", timezone: "UTC" },
      () => new Date("2025-06-15T20:00:00Z").getTime(),
    );

    // 20:00 UTC is outside 09:00-17:00 -> not business hours
    expect(calc.checkBusinessHours()).toBe(false);

    // Update to wider hours
    calc.updateConfig(DEFAULT_REST_CONFIG, { start: "06:00", end: "22:00", timezone: "UTC" });

    // 20:00 UTC is now within 06:00-22:00 -> business hours
    expect(calc.checkBusinessHours()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("RestCalculator edge cases", () => {
  test("handles invalid timezone gracefully (falls back to system time)", () => {
    const businessHours: BusinessHoursConfig = {
      start: "07:00",
      end: "23:00",
      timezone: "Invalid/Timezone",
    };
    // Should not throw
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger, businessHours);
    const result = calc.checkBusinessHours();
    expect(typeof result).toBe("boolean");
  });

  test("handles cross-midnight business hours", () => {
    const businessHours: BusinessHoursConfig = {
      start: "22:00",
      end: "06:00",
      timezone: "UTC",
    };
    // 23:00 UTC -- within cross-midnight window
    const calc = new RestCalculator(
      DEFAULT_REST_CONFIG,
      logger,
      businessHours,
      () => new Date("2025-06-15T23:00:00Z").getTime(),
    );
    expect(calc.checkBusinessHours()).toBe(true);

    // 12:00 UTC -- outside cross-midnight window
    const calcMidday = new RestCalculator(
      DEFAULT_REST_CONFIG,
      logger,
      businessHours,
      () => new Date("2025-06-15T12:00:00Z").getTime(),
    );
    expect(calcMidday.checkBusinessHours()).toBe(false);
  });

  test("defaults to DEFAULT_BUSINESS_HOURS when not provided", () => {
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger);
    // Should use Europe/Berlin timezone and 07:00-23:00 range without error
    const result = calc.checkBusinessHours();
    expect(typeof result).toBe("boolean");
  });
});
