import { describe, expect, test } from "bun:test";
import { createTestConfig } from "../test-config.js";

describe("createTestConfig", () => {
  test("creates valid config with defaults", () => {
    const config = createTestConfig();
    expect(config.identity.name).toBe("TestEidolon");
    expect(config.identity.ownerName).toBe("TestUser");
    expect(config.brain.accounts).toHaveLength(1);
    expect(config.brain.accounts[0]?.name).toBe("test-account");
  });

  test("merges overrides into config", () => {
    const config = createTestConfig({
      identity: { name: "CustomName", ownerName: "CustomOwner" },
    });
    expect(config.identity.name).toBe("CustomName");
    expect(config.identity.ownerName).toBe("CustomOwner");
  });

  test("deep merges nested overrides", () => {
    const config = createTestConfig({
      logging: { level: "debug" },
    });
    expect(config.logging.level).toBe("debug");
    // Other logging defaults should still be present
    expect(config.logging.format).toBe("json");
  });
});
