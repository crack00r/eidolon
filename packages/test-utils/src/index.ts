// @eidolon/test-utils -- Test helpers and mocks
// Depends on @eidolon/protocol only. NEVER on @eidolon/core.

export { FakeClaudeProcess } from "./fake-claude-process.ts";
export { createTestConfig } from "./test-config.ts";
export { createTestEvent, createTestUserMessageEvent } from "./test-events.ts";
export { collectAsync, eventually, sleep, waitFor } from "./test-helpers.ts";
