/**
 * Tests for user schemas -- Zod validation and row conversion.
 */

import { describe, expect, test } from "bun:test";
import {
  ChannelMappingSchema,
  CreateUserInputSchema,
  DEFAULT_USER_ID,
  rowToUser,
  UpdateUserInputSchema,
  UserPreferencesSchema,
  UserSchema,
} from "../schema.ts";
import type { UserRow } from "../schema.ts";

describe("User Schemas", () => {
  describe("UserSchema", () => {
    test("validates a complete user", () => {
      const result = UserSchema.safeParse({
        id: "u1",
        name: "Alice",
        channelMappings: [{ channelType: "telegram", externalUserId: "12345" }],
        preferences: { language: "de" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(result.success).toBe(true);
    });

    test("rejects empty name", () => {
      const result = UserSchema.safeParse({
        id: "u1",
        name: "",
        channelMappings: [],
        preferences: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(result.success).toBe(false);
    });

    test("rejects name exceeding max length", () => {
      const result = UserSchema.safeParse({
        id: "u1",
        name: "x".repeat(201),
        channelMappings: [],
        preferences: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ChannelMappingSchema", () => {
    test("validates valid mapping", () => {
      const result = ChannelMappingSchema.safeParse({
        channelType: "telegram",
        externalUserId: "12345",
      });
      expect(result.success).toBe(true);
    });

    test("rejects empty channelType", () => {
      const result = ChannelMappingSchema.safeParse({
        channelType: "",
        externalUserId: "12345",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("UserPreferencesSchema", () => {
    test("validates empty preferences", () => {
      const result = UserPreferencesSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    test("validates preferences with all fields", () => {
      const result = UserPreferencesSchema.safeParse({
        language: "de",
        timezone: "Europe/Berlin",
        dndSchedule: { start: "22:00", end: "07:00" },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("CreateUserInputSchema", () => {
    test("requires only name", () => {
      const result = CreateUserInputSchema.safeParse({ name: "Alice" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.channelMappings).toEqual([]);
    });

    test("accepts optional id", () => {
      const result = CreateUserInputSchema.safeParse({ id: "custom", name: "Alice" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.id).toBe("custom");
    });
  });

  describe("UpdateUserInputSchema", () => {
    test("all fields are optional", () => {
      const result = UpdateUserInputSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    test("validates partial update", () => {
      const result = UpdateUserInputSchema.safeParse({ name: "Updated" });
      expect(result.success).toBe(true);
    });
  });

  describe("rowToUser", () => {
    test("converts a valid row", () => {
      const row: UserRow = {
        id: "u1",
        name: "Alice",
        channel_mappings: JSON.stringify([{ channelType: "telegram", externalUserId: "12345" }]),
        preferences: JSON.stringify({ language: "de" }),
        created_at: 1000,
        updated_at: 2000,
      };

      const user = rowToUser(row);
      expect(user.id).toBe("u1");
      expect(user.name).toBe("Alice");
      expect(user.channelMappings).toHaveLength(1);
      expect(user.preferences.language).toBe("de");
      expect(user.createdAt).toBe(1000);
      expect(user.updatedAt).toBe(2000);
    });

    test("handles malformed JSON gracefully", () => {
      const row: UserRow = {
        id: "u1",
        name: "Bob",
        channel_mappings: "invalid json",
        preferences: "also invalid",
        created_at: 1000,
        updated_at: 2000,
      };

      const user = rowToUser(row);
      expect(user.channelMappings).toEqual([]);
      expect(user.preferences).toEqual({});
    });
  });

  describe("DEFAULT_USER_ID", () => {
    test("is 'default'", () => {
      expect(DEFAULT_USER_ID).toBe("default");
    });
  });
});
