/**
 * Wyoming protocol configuration schema.
 *
 * Defines the Zod schema for the `wyoming:` config section and
 * default values for server configuration.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_WYOMING_PORT = 10_400;
const MAX_WYOMING_PORT = 65_535;
const MIN_WYOMING_PORT = 1;
const MAX_SATELLITE_ID_LENGTH = 128;

/**
 * Allowed characters in satellite IDs: alphanumeric, hyphens, underscores, dots, colons.
 * Prevents injection of control characters.
 */
const SATELLITE_ID_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const WyomingConfigSchema = z.object({
  /** Whether the Wyoming server is enabled. */
  enabled: z.boolean().default(false),
  /** TCP port to listen on. */
  port: z.number().int().min(MIN_WYOMING_PORT).max(MAX_WYOMING_PORT).default(DEFAULT_WYOMING_PORT),
  /** Allowed satellite IDs. Empty array means all satellites are allowed. */
  allowedSatellites: z
    .array(
      z
        .string()
        .min(1)
        .max(MAX_SATELLITE_ID_LENGTH)
        .regex(SATELLITE_ID_PATTERN, "Satellite ID contains disallowed characters"),
    )
    .default([]),
  /** Audio format expected from satellites. */
  audioFormat: z.enum(["wav", "raw"]).default("wav"),
  /** Audio sample rate in Hz. */
  sampleRate: z.number().int().min(8_000).max(48_000).default(16_000),
  /** Audio channels (mono = 1, stereo = 2). */
  audioChannels: z.number().int().min(1).max(2).default(1),
  /** Bits per audio sample. */
  bitsPerSample: z
    .number()
    .int()
    .refine((v) => v === 8 || v === 16 || v === 32, {
      message: "bitsPerSample must be 8, 16, or 32",
    })
    .default(16),
});

export type WyomingConfig = z.infer<typeof WyomingConfigSchema>;
