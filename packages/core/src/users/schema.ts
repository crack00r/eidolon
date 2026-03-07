/**
 * Zod schemas and types for the multi-user system.
 *
 * Defines user identity, channel mappings, and preferences.
 * The default user ID "default" provides backward compatibility
 * for single-user setups.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default user ID for backward-compatible single-user mode. */
export const DEFAULT_USER_ID = "default";

/** Maximum user name length. */
export const MAX_USER_NAME_LENGTH = 200;

/** Maximum number of channel mappings per user. */
export const MAX_CHANNEL_MAPPINGS = 50;

// ---------------------------------------------------------------------------
// Channel Mapping
// ---------------------------------------------------------------------------

export const ChannelMappingSchema = z.object({
  /** Channel type: telegram, discord, slack, gateway, etc. */
  channelType: z.string().min(1).max(50),
  /** External user ID on that channel (e.g., Telegram numeric ID as string). */
  externalUserId: z.string().min(1).max(200),
});

export type ChannelMapping = z.infer<typeof ChannelMappingSchema>;

// ---------------------------------------------------------------------------
// User Preferences
// ---------------------------------------------------------------------------

export const UserPreferencesSchema = z.object({
  /** User's preferred language (BCP-47, e.g., "de", "en"). */
  language: z.string().max(10).optional(),
  /** User's timezone (IANA, e.g., "Europe/Berlin"). */
  timezone: z.string().max(50).optional(),
  /** Custom DND schedule override. */
  dndSchedule: z
    .object({
      start: z.string(),
      end: z.string(),
    })
    .optional(),
});

export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(MAX_USER_NAME_LENGTH),
  channelMappings: z.array(ChannelMappingSchema).max(MAX_CHANNEL_MAPPINGS),
  preferences: UserPreferencesSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type User = z.infer<typeof UserSchema>;

// ---------------------------------------------------------------------------
// Input types for CRUD
// ---------------------------------------------------------------------------

export const CreateUserInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(MAX_USER_NAME_LENGTH),
  channelMappings: z.array(ChannelMappingSchema).max(MAX_CHANNEL_MAPPINGS).default([]),
  preferences: UserPreferencesSchema.default({}),
});

export type CreateUserInput = z.input<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  name: z.string().min(1).max(MAX_USER_NAME_LENGTH).optional(),
  channelMappings: z.array(ChannelMappingSchema).max(MAX_CHANNEL_MAPPINGS).optional(),
  preferences: UserPreferencesSchema.optional(),
});

export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

// ---------------------------------------------------------------------------
// DB Row shape
// ---------------------------------------------------------------------------

export interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly channel_mappings: string;
  readonly preferences: string;
  readonly created_at: number;
  readonly updated_at: number;
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

export function rowToUser(row: UserRow): User {
  let channelMappings: ChannelMapping[];
  try {
    const parsed: unknown = JSON.parse(row.channel_mappings);
    channelMappings = Array.isArray(parsed) ? (parsed as ChannelMapping[]) : [];
  } catch {
    channelMappings = [];
  }

  let preferences: UserPreferences;
  try {
    const parsed: unknown = JSON.parse(row.preferences);
    preferences =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as UserPreferences) : {};
  } catch {
    preferences = {};
  }

  return {
    id: row.id,
    name: row.name,
    channelMappings,
    preferences,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
