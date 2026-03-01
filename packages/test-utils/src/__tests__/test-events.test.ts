import { describe, expect, test } from "bun:test";
import { createTestEvent, createTestUserMessageEvent } from "../test-events.js";

describe("createTestEvent", () => {
  test("creates event with required fields", () => {
    const event = createTestEvent("system:startup", { ready: true });
    expect(event.id).toBeDefined();
    expect(event.type).toBe("system:startup");
    expect(event.priority).toBe("normal");
    expect(event.payload).toEqual({ ready: true });
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.source).toBe("test");
  });

  test("applies overrides", () => {
    const event = createTestEvent("system:startup", null, {
      priority: "critical",
      source: "custom-source",
    });
    expect(event.priority).toBe("critical");
    expect(event.source).toBe("custom-source");
  });
});

describe("createTestUserMessageEvent", () => {
  test("creates user message event", () => {
    const event = createTestUserMessageEvent("Hello Eidolon");
    expect(event.type).toBe("user:message");
    expect(event.priority).toBe("high");
    expect(event.payload.text).toBe("Hello Eidolon");
    expect(event.payload.channelId).toBe("test-channel");
    expect(event.payload.userId).toBe("test-user");
  });
});
