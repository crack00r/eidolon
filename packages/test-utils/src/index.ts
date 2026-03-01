// @eidolon/test-utils -- Test helpers and mocks
// Depends on @eidolon/protocol only. NEVER on @eidolon/core.

export { FakeClaudeProcess } from "./fake-claude-process.js";
export { createTestConfig } from "./test-config.js";
export { createTestEvent, createTestUserMessageEvent } from "./test-events.js";
export { collectAsync, eventually, sleep, waitFor } from "./test-helpers.js";
