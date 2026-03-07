/**
 * Anticipation Engine configuration schema.
 * Controls proactive intelligence: pattern detection, notification throttling,
 * and composition mode.
 */

import { z } from "zod";

export const AnticipationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalMinutes: z.number().int().positive().default(5),
  minConfidence: z.number().min(0).max(1).default(0.6),
  cooldownMinutes: z.number().int().positive().default(240),
  maxSuggestionsPerHour: z.number().int().positive().default(3),
  compositionMode: z.enum(["template", "llm"]).default("template"),
  channel: z.string().default("telegram"),
  detectors: z
    .object({
      meetingPrep: z
        .object({
          enabled: z.boolean().default(true),
          windowMinutes: z.number().int().positive().default(60),
        })
        .default({}),
      travelPrep: z
        .object({
          enabled: z.boolean().default(true),
          windowHours: z.number().int().positive().default(24),
          homeCity: z.string().default(""),
        })
        .default({}),
      healthNudge: z
        .object({
          enabled: z.boolean().default(false),
          afterHour: z.number().int().min(0).max(23).default(17),
          activityTags: z.array(z.string()).default(["training", "exercise", "workout", "gym"]),
        })
        .default({}),
      followUp: z
        .object({
          enabled: z.boolean().default(true),
          delayHours: z.number().int().positive().default(48),
        })
        .default({}),
      birthday: z
        .object({
          enabled: z.boolean().default(true),
          daysBefore: z.number().int().min(0).max(7).default(1),
        })
        .default({}),
    })
    .default({}),
});

export type AnticipationConfig = z.infer<typeof AnticipationConfigSchema>;
