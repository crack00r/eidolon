import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../logging/logger.ts";
import { ConfigWatcher } from "../watcher.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

/** Minimal valid raw config object that passes Zod validation. */
function makeRawConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    identity: { name: "TestEidolon", ownerName: "TestUser" },
    brain: {
      accounts: [{ type: "api-key", name: "test", credential: "sk-test-000", priority: 50, enabled: true }],
      model: {},
      session: {},
    },
    loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
    memory: { extraction: {}, dreaming: {}, search: {}, embedding: {}, retention: {}, entityResolution: {} },
    learning: { relevance: {}, autoImplement: {}, budget: {} },
    channels: {},
    gateway: { auth: { type: "none" } },
    gpu: { tts: {}, stt: {}, fallback: {} },
    security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
    database: {},
    logging: {},
    daemon: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfigWatcher", () => {
  let tempDir: string;
  let configPath: string;
  const watchers: ConfigWatcher[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "eidolon-watcher-test-"));
    configPath = join(tempDir, "eidolon.json");
  });

  afterEach(() => {
    for (const w of watchers) {
      w.stop();
    }
    watchers.length = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(raw: Record<string, unknown>, path?: string): void {
    const target = path ?? configPath;
    writeFileSync(target, JSON.stringify(raw));
  }

  function makeWatcher(opts?: { debounceMs?: number }): ConfigWatcher {
    const watcher = new ConfigWatcher(configPath, {
      debounceMs: opts?.debounceMs ?? 0,
      logger: createSilentLogger(),
    });
    watchers.push(watcher);
    return watcher;
  }

  // -----------------------------------------------------------------------
  // Permission checks
  // -----------------------------------------------------------------------

  describe("file permission checks", () => {
    test("reload succeeds when file has 0600 permissions", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      // Trigger reload directly by accessing the private method via any
      // We test this indirectly by calling reload() through the public start + file change
      // But since we can't easily trigger a file change event in a test, we'll test via
      // directly invoking the reload. ConfigWatcher.reload is private, so we access it.
      await (watcher as any).reload();

      expect(received).toHaveLength(1);
    });

    test("reload succeeds when file has 0640 permissions", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o640);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();

      expect(received).toHaveLength(1);
    });

    test("reload refuses when file has 0644 permissions", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o644);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();

      // Handler should NOT have been called
      expect(received).toHaveLength(0);
    });

    test("reload refuses when file has 0755 permissions", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o755);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();

      expect(received).toHaveLength(0);
    });

    test("reload refuses when file has 0666 permissions", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o666);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();

      expect(received).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Locked fields
  // -----------------------------------------------------------------------

  describe("locked fields", () => {
    test("blocks reload when brain.accounts changes", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      // First reload to establish currentConfig
      await (watcher as any).reload();
      expect(received).toHaveLength(1);

      // Write new config with different brain.accounts
      const modified = makeRawConfig({
        brain: {
          accounts: [{ type: "api-key", name: "different", credential: "sk-other-999", priority: 10, enabled: true }],
          model: {},
          session: {},
        },
      });
      writeConfig(modified);

      // Second reload should be blocked
      await (watcher as any).reload();
      expect(received).toHaveLength(1); // Still 1, no new handler call
    });

    test("blocks reload when security changes", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();
      expect(received).toHaveLength(1);

      // Change security section
      const modified = makeRawConfig({
        security: {
          policies: { shellExecution: "safe" },
          approval: {},
          sandbox: {},
          audit: {},
        },
      });
      writeConfig(modified);

      await (watcher as any).reload();
      expect(received).toHaveLength(1); // Blocked
    });

    test("blocks reload when database changes", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();
      expect(received).toHaveLength(1);

      const modified = makeRawConfig({
        database: { walMode: false },
      });
      writeConfig(modified);

      await (watcher as any).reload();
      expect(received).toHaveLength(1); // Blocked
    });

    test("blocks reload when gateway.auth changes", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();
      expect(received).toHaveLength(1);

      const modified = makeRawConfig({
        gateway: { auth: { type: "token", token: "secret" } },
      });
      writeConfig(modified);

      await (watcher as any).reload();
      expect(received).toHaveLength(1); // Blocked
    });

    test("allows reload when only non-locked fields change", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();
      expect(received).toHaveLength(1);

      // Change identity (non-locked field)
      const modified = makeRawConfig({
        identity: { name: "UpdatedEidolon", ownerName: "TestUser" },
      });
      writeConfig(modified);

      await (watcher as any).reload();
      expect(received).toHaveLength(2); // Second config delivered
    });

    test("allows reload when logging level changes", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();
      expect(received).toHaveLength(1);

      const modified = makeRawConfig({ logging: { level: "debug" } });
      writeConfig(modified);

      await (watcher as any).reload();
      expect(received).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Handler notification
  // -----------------------------------------------------------------------

  describe("handler notification", () => {
    test("notifies all registered handlers", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const results1: unknown[] = [];
      const results2: unknown[] = [];
      watcher.onChange((config) => results1.push(config));
      watcher.onChange((config) => results2.push(config));

      await (watcher as any).reload();

      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(1);
    });

    test("continues notifying remaining handlers if one throws", async () => {
      const raw = makeRawConfig();
      writeConfig(raw);
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const results: unknown[] = [];
      watcher.onChange(() => {
        throw new Error("handler error");
      });
      watcher.onChange((config) => results.push(config));

      await (watcher as any).reload();

      // Second handler still called despite first throwing
      expect(results).toHaveLength(1);
    });

    test("does not notify handlers when config is invalid", async () => {
      // Write invalid config (missing required fields)
      writeFileSync(configPath, JSON.stringify({ identity: { name: "Bad" } }));
      chmodSync(configPath, 0o600);

      const watcher = makeWatcher();
      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      await (watcher as any).reload();

      expect(received).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    test("start is idempotent", () => {
      writeConfig(makeRawConfig());
      const watcher = makeWatcher();

      // Calling start twice should not throw
      watcher.start();
      watcher.start();
      watcher.stop();
    });

    test("stop without start does not throw", () => {
      const watcher = makeWatcher();
      watcher.stop();
    });

    test("stop clears debounce timer", async () => {
      writeConfig(makeRawConfig());
      chmodSync(configPath, 0o600);

      const watcher = new ConfigWatcher(configPath, {
        debounceMs: 5000, // Long debounce so we can stop before it fires
        logger: createSilentLogger(),
      });
      watchers.push(watcher);

      const received: unknown[] = [];
      watcher.onChange((config) => received.push(config));

      watcher.start();
      // Trigger a change by scheduling reload internally
      (watcher as any).scheduleReload();

      // Stop immediately -- debounce should be cancelled
      watcher.stop();

      // Wait a bit to ensure the debounce timer did not fire
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(0);
    });
  });
});
