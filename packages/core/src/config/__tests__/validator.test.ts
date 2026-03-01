import { describe, expect, test } from "bun:test";
import { createTestConfig } from "@eidolon/test-utils";
import { validateAndResolve } from "../loader.js";

describe("validateAndResolve", () => {
  test("valid minimal config passes", () => {
    const raw = {
      identity: { ownerName: "Manuel" },
      brain: {
        accounts: [{ type: "api-key", name: "test", credential: "sk-test" }],
        model: {},
        session: {},
      },
      loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
      memory: { extraction: {}, dreaming: {}, search: {}, embedding: {}, retention: {}, entityResolution: {} },
      learning: { relevance: {}, autoImplement: {}, budget: {} },
      channels: {},
      gateway: { auth: {} },
      gpu: { tts: {}, stt: {}, fallback: {} },
      security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
      database: {},
      logging: {},
      daemon: {},
    };

    const result = validateAndResolve(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.identity.ownerName).toBe("Manuel");
      expect(result.value.identity.name).toBe("Eidolon"); // default
    }
  });

  test("missing required fields fail with clear error", () => {
    // identity.ownerName is required, brain.accounts is required
    const result = validateAndResolve({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("validation failed");
    }
  });

  test("defaults are filled correctly", () => {
    const raw = {
      identity: { ownerName: "Manuel" },
      brain: {
        accounts: [{ type: "api-key", name: "main", credential: "sk-xyz" }],
        model: {},
        session: {},
      },
      loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
      memory: { extraction: {}, dreaming: {}, search: {}, embedding: {}, retention: {}, entityResolution: {} },
      learning: { relevance: {}, autoImplement: {}, budget: {} },
      channels: {},
      gateway: { auth: {} },
      gpu: { tts: {}, stt: {}, fallback: {} },
      security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
      database: {},
      logging: {},
      daemon: {},
    };

    const result = validateAndResolve(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Zod defaults
      expect(result.value.logging.level).toBe("info");
      expect(result.value.gateway.port).toBe(8419);
      expect(result.value.security.policies.shellExecution).toBe("needs_approval");
      // Runtime defaults
      expect(result.value.database.directory).toBeTruthy();
      expect(result.value.logging.directory).toBeTruthy();
      expect(result.value.daemon.pidFile).toBeTruthy();
    }
  });

  test("deeply nested validation works", () => {
    const raw = {
      identity: { ownerName: "Manuel" },
      brain: {
        accounts: [{ type: "api-key", name: "main", credential: "sk-xyz" }],
        model: {},
        session: { maxTurns: -5 }, // invalid: must be positive
      },
      loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
      memory: { extraction: {}, dreaming: {}, search: {}, embedding: {}, retention: {}, entityResolution: {} },
      learning: { relevance: {}, autoImplement: {}, budget: {} },
      channels: {},
      gateway: { auth: {} },
      gpu: { tts: {}, stt: {}, fallback: {} },
      security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
      database: {},
      logging: {},
      daemon: {},
    };

    const result = validateAndResolve(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("brain.session.maxTurns");
    }
  });

  test("full config from createTestConfig passes validation", () => {
    const config = createTestConfig();
    // Re-validate the already-parsed config (should still pass)
    const result = validateAndResolve(config);
    expect(result.ok).toBe(true);
  });
});
