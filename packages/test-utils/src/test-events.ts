/**
 * Factory functions for creating test BusEvent instances.
 */

import { randomUUID } from "node:crypto";
import type { BusEvent, EventPriority, EventType } from "@eidolon/protocol";

/**
 * Create a BusEvent for testing.
 */
export function createTestEvent<T = unknown>(
  type: EventType,
  payload: T,
  overrides?: Partial<BusEvent<T>>,
): BusEvent<T> {
  return {
    id: randomUUID(),
    type,
    priority: "normal" as EventPriority,
    payload,
    timestamp: Date.now(),
    source: "test",
    ...overrides,
  };
}

/**
 * Create a user message event for testing.
 */
export function createTestUserMessageEvent(
  text: string,
): BusEvent<{ channelId: string; userId: string; text: string }> {
  return createTestEvent(
    "user:message",
    {
      channelId: "test-channel",
      userId: "test-user",
      text,
    },
    { priority: "high" as EventPriority },
  );
}
