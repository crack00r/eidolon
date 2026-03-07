/**
 * Tests for Wyoming configuration schema.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_WYOMING_PORT, WyomingConfigSchema } from "../config.ts";

describe("WyomingConfigSchema", () => {
  it("accepts minimal config with defaults", () => {
    const result = WyomingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.enabled).toBe(false);
    expect(result.data.port).toBe(DEFAULT_WYOMING_PORT);
    expect(result.data.allowedSatellites).toEqual([]);
    expect(result.data.audioFormat).toBe("wav");
    expect(result.data.sampleRate).toBe(16_000);
    expect(result.data.audioChannels).toBe(1);
    expect(result.data.bitsPerSample).toBe(16);
  });

  it("accepts full valid config", () => {
    const result = WyomingConfigSchema.safeParse({
      enabled: true,
      port: 10_500,
      allowedSatellites: ["satellite-1", "satellite-2"],
      audioFormat: "raw",
      sampleRate: 22_050,
      audioChannels: 2,
      bitsPerSample: 32,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.enabled).toBe(true);
    expect(result.data.port).toBe(10_500);
    expect(result.data.allowedSatellites).toEqual(["satellite-1", "satellite-2"]);
    expect(result.data.audioFormat).toBe("raw");
    expect(result.data.sampleRate).toBe(22_050);
    expect(result.data.audioChannels).toBe(2);
    expect(result.data.bitsPerSample).toBe(32);
  });

  it("rejects invalid port", () => {
    const result = WyomingConfigSchema.safeParse({ port: 70_000 });
    expect(result.success).toBe(false);
  });

  it("rejects negative port", () => {
    const result = WyomingConfigSchema.safeParse({ port: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid audio format", () => {
    const result = WyomingConfigSchema.safeParse({ audioFormat: "mp3" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid sample rate", () => {
    const result = WyomingConfigSchema.safeParse({ sampleRate: 100 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid bits per sample", () => {
    const result = WyomingConfigSchema.safeParse({ bitsPerSample: 24 });
    expect(result.success).toBe(false);
  });

  it("rejects satellite IDs with special characters", () => {
    const result = WyomingConfigSchema.safeParse({
      allowedSatellites: ["valid-id", "invalid id with spaces"],
    });
    expect(result.success).toBe(false);
  });

  it("allows satellite IDs with dots, hyphens, underscores, colons", () => {
    const result = WyomingConfigSchema.safeParse({
      allowedSatellites: ["my.satellite", "my-sat_1", "192.168.1.100:5000"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty satellite ID strings", () => {
    const result = WyomingConfigSchema.safeParse({
      allowedSatellites: [""],
    });
    expect(result.success).toBe(false);
  });
});
