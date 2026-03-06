/**
 * Tests for the channel status CLI command helpers.
 */

import { describe, expect, test } from "bun:test";
import type { EidolonConfig } from "@eidolon/protocol";
import { buildChannelStatuses } from "../commands/channel.ts";

// ---------------------------------------------------------------------------
// Minimal config factory
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<EidolonConfig["channels"]> = {}): EidolonConfig {
  return {
    channels: {
      telegram: undefined,
      discord: undefined,
      whatsapp: undefined,
      email: undefined,
      ...overrides,
    },
  } as unknown as EidolonConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildChannelStatuses", () => {
  test("returns all 4 channels as not configured when channels are undefined", () => {
    const config = makeConfig();
    const statuses = buildChannelStatuses(config);

    expect(statuses).toHaveLength(4);

    const names = statuses.map((s) => s.Channel);
    expect(names).toContain("telegram");
    expect(names).toContain("discord");
    expect(names).toContain("whatsapp");
    expect(names).toContain("email");

    for (const s of statuses) {
      expect(s.Enabled).toBe("no");
      expect(s.Status).toBe("not configured");
    }
  });

  test("shows telegram as configured when enabled with token", () => {
    const config = makeConfig({
      telegram: {
        enabled: true,
        botToken: "test-token",
        allowedUserIds: [111, 222],
        notifyOnDiscovery: true,
      },
    });

    const statuses = buildChannelStatuses(config);
    const telegram = statuses.find((s) => s.Channel === "telegram");
    expect(telegram).toBeDefined();
    expect(telegram?.Enabled).toBe("yes");
    expect(telegram?.Status).toBe("configured");
    expect(telegram?.Details).toContain("2 allowed users");
  });

  test("shows telegram with DND schedule in details", () => {
    const config = makeConfig({
      telegram: {
        enabled: true,
        botToken: { $secret: "TELEGRAM_BOT_TOKEN" },
        allowedUserIds: [123],
        notifyOnDiscovery: true,
        dndSchedule: { start: "22:00", end: "07:00" },
      },
    });

    const statuses = buildChannelStatuses(config);
    const telegram = statuses.find((s) => s.Channel === "telegram");
    expect(telegram?.Details).toContain("DND 22:00-07:00");
  });

  test("shows whatsapp as configured when enabled with access token", () => {
    const config = makeConfig({
      whatsapp: {
        enabled: true,
        accessToken: "whatsapp-token",
        phoneNumberId: "12345",
        businessAccountId: "biz-123",
        verifyToken: "verify",
        appSecret: "secret",
        allowedPhoneNumbers: [],
        notifyOnDiscovery: true,
      },
    });

    const statuses = buildChannelStatuses(config);
    const wa = statuses.find((s) => s.Channel === "whatsapp");
    expect(wa?.Enabled).toBe("yes");
    expect(wa?.Status).toBe("configured");
    expect(wa?.Details).toContain("phone: 12345");
  });

  test("shows email as disabled when present but not enabled", () => {
    const config = makeConfig({
      email: {
        enabled: false,
        imap: {
          host: "imap.example.com",
          port: 993,
          user: "u",
          password: "p",
          tls: true,
          pollIntervalMs: 30000,
          folder: "INBOX",
        },
        smtp: { host: "smtp.example.com", port: 587, user: "u", password: "p", tls: true, from: "eidolon@example.com" },
        allowedSenders: [],
        subjectPrefix: "[Eidolon]",
        maxAttachmentSizeMb: 10,
        threadingEnabled: true,
      },
    });

    const statuses = buildChannelStatuses(config);
    const email = statuses.find((s) => s.Channel === "email");
    expect(email?.Enabled).toBe("no");
    expect(email?.Status).toBe("not configured");
    expect(email?.Details).toBe("disabled in config");
  });
});
