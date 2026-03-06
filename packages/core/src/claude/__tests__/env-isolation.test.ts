/**
 * P1-23: API key subprocess isolation verification.
 *
 * Tests that the ClaudeCodeManager env filtering logic:
 * - Whitelists only SAFE_ENV_KEYS from parent process env
 * - Passes safe ANTHROPIC_ and EIDOLON_ prefixed vars
 * - Filters out SECRET_ENV_KEYS (EIDOLON_MASTER_KEY, EIDOLON_GPU_API_KEY)
 * - Filters out DANGEROUS_ENV_KEYS from options.env (PATH, LD_PRELOAD, etc.)
 * - Does not leak arbitrary parent env vars to the subprocess
 *
 * Since we cannot spawn real Claude Code in tests, we test the env filtering
 * logic by extracting and verifying the same logic used in ClaudeCodeManager.run().
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Extracted env filtering logic from ClaudeCodeManager.run()
// This mirrors the exact logic in manager.ts lines 50-103
// ---------------------------------------------------------------------------

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TZ",
  "NODE_ENV",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

const SAFE_ENV_PREFIXES = ["ANTHROPIC_", "EIDOLON_"];

const SECRET_ENV_KEYS = new Set(["EIDOLON_MASTER_KEY", "EIDOLON_GPU_API_KEY"]);

const DANGEROUS_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_LIBRARY_PATH",
  "EIDOLON_MASTER_KEY",
  "EIDOLON_GPU_API_KEY",
  "NODE_OPTIONS",
]);

/**
 * Build the safe env from the parent process env.
 * This is the logic from ClaudeCodeManager.run() extracted for testing.
 */
function buildSafeEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = parentEnv[key];
    if (val) safeEnv[key] = val;
  }
  for (const [key, val] of Object.entries(parentEnv)) {
    if (val && SAFE_ENV_PREFIXES.some((p) => key.startsWith(p)) && !SECRET_ENV_KEYS.has(key)) {
      safeEnv[key] = val;
    }
  }
  return safeEnv;
}

/**
 * Filter options.env to reject dangerous keys.
 * This is the logic from ClaudeCodeManager.run() extracted for testing.
 */
function filterOptionsEnv(optionsEnv: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, val] of Object.entries(optionsEnv)) {
    if (!DANGEROUS_ENV_KEYS.has(key)) {
      filtered[key] = val;
    }
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Tests: Safe env from parent process
// ---------------------------------------------------------------------------

describe("API key subprocess isolation -- safe env from parent", () => {
  test("includes whitelisted keys present in parent env", () => {
    const parentEnv: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      USER: "testuser",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      TZ: "Europe/Berlin",
      NODE_ENV: "test",
      XDG_CONFIG_HOME: "/home/user/.config",
      XDG_DATA_HOME: "/home/user/.local/share",
    };

    const result = buildSafeEnv(parentEnv);

    for (const key of SAFE_ENV_KEYS) {
      expect(result[key]).toBe(parentEnv[key]);
    }
  });

  test("omits whitelisted keys not present in parent env", () => {
    const parentEnv: Record<string, string> = {
      PATH: "/usr/bin",
    };

    const result = buildSafeEnv(parentEnv);

    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBeUndefined();
    expect(result.TMPDIR).toBeUndefined();
  });

  test("passes ANTHROPIC_ prefixed vars through", () => {
    const parentEnv: Record<string, string> = {
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    };

    const result = buildSafeEnv(parentEnv);

    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-test-key");
    expect(result.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  test("passes safe EIDOLON_ prefixed vars through", () => {
    const parentEnv: Record<string, string> = {
      EIDOLON_LOGGING__LEVEL: "debug",
      EIDOLON_CONFIG: "/etc/eidolon/eidolon.json",
    };

    const result = buildSafeEnv(parentEnv);

    expect(result.EIDOLON_LOGGING__LEVEL).toBe("debug");
    expect(result.EIDOLON_CONFIG).toBe("/etc/eidolon/eidolon.json");
  });

  test("excludes EIDOLON_MASTER_KEY from subprocess env", () => {
    const parentEnv: Record<string, string> = {
      EIDOLON_MASTER_KEY: "super-secret-master-key",
      EIDOLON_CONFIG: "/etc/eidolon/eidolon.json",
    };

    const result = buildSafeEnv(parentEnv);

    expect(result.EIDOLON_MASTER_KEY).toBeUndefined();
    expect(result.EIDOLON_CONFIG).toBe("/etc/eidolon/eidolon.json");
  });

  test("excludes EIDOLON_GPU_API_KEY from subprocess env", () => {
    const parentEnv: Record<string, string> = {
      EIDOLON_GPU_API_KEY: "gpu-secret-key",
      EIDOLON_LOGGING__LEVEL: "info",
    };

    const result = buildSafeEnv(parentEnv);

    expect(result.EIDOLON_GPU_API_KEY).toBeUndefined();
    expect(result.EIDOLON_LOGGING__LEVEL).toBe("info");
  });

  test("does not leak arbitrary parent env vars", () => {
    const parentEnv: Record<string, string> = {
      PATH: "/usr/bin",
      DATABASE_PASSWORD: "db-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      RANDOM_VAR: "should-not-leak",
      GITHUB_TOKEN: "ghp_123",
    };

    const result = buildSafeEnv(parentEnv);

    expect(result.PATH).toBe("/usr/bin");
    expect(result.DATABASE_PASSWORD).toBeUndefined();
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.RANDOM_VAR).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
  });

  test("handles empty parent env", () => {
    const result = buildSafeEnv({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Dangerous key filtering on options.env
// ---------------------------------------------------------------------------

describe("API key subprocess isolation -- dangerous env key filtering", () => {
  test("filters out PATH override from options.env", () => {
    const result = filterOptionsEnv({ PATH: "/malicious/path", CUSTOM_VAR: "safe" });

    expect(result.PATH).toBeUndefined();
    expect(result.CUSTOM_VAR).toBe("safe");
  });

  test("filters out HOME override from options.env", () => {
    const result = filterOptionsEnv({ HOME: "/attacker/home" });
    expect(result.HOME).toBeUndefined();
  });

  test("filters out LD_PRELOAD (dynamic linker injection)", () => {
    const result = filterOptionsEnv({ LD_PRELOAD: "/malicious/lib.so" });
    expect(result.LD_PRELOAD).toBeUndefined();
  });

  test("filters out LD_LIBRARY_PATH (library search path hijack)", () => {
    const result = filterOptionsEnv({ LD_LIBRARY_PATH: "/malicious/lib" });
    expect(result.LD_LIBRARY_PATH).toBeUndefined();
  });

  test("filters out DYLD_INSERT_LIBRARIES (macOS injection vector)", () => {
    const result = filterOptionsEnv({ DYLD_INSERT_LIBRARIES: "/malicious/dylib" });
    expect(result.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  test("filters out DYLD_FRAMEWORK_PATH (macOS framework hijack)", () => {
    const result = filterOptionsEnv({ DYLD_FRAMEWORK_PATH: "/fake/frameworks" });
    expect(result.DYLD_FRAMEWORK_PATH).toBeUndefined();
  });

  test("filters out DYLD_LIBRARY_PATH (macOS library hijack)", () => {
    const result = filterOptionsEnv({ DYLD_LIBRARY_PATH: "/fake/libs" });
    expect(result.DYLD_LIBRARY_PATH).toBeUndefined();
  });

  test("filters out EIDOLON_MASTER_KEY from options.env", () => {
    const result = filterOptionsEnv({ EIDOLON_MASTER_KEY: "stolen-key" });
    expect(result.EIDOLON_MASTER_KEY).toBeUndefined();
  });

  test("filters out EIDOLON_GPU_API_KEY from options.env", () => {
    const result = filterOptionsEnv({ EIDOLON_GPU_API_KEY: "stolen-gpu-key" });
    expect(result.EIDOLON_GPU_API_KEY).toBeUndefined();
  });

  test("filters out NODE_OPTIONS (can inject --require for code execution)", () => {
    const result = filterOptionsEnv({ NODE_OPTIONS: "--require=/malicious/module.js" });
    expect(result.NODE_OPTIONS).toBeUndefined();
  });

  test("passes through safe custom env vars", () => {
    const result = filterOptionsEnv({
      CUSTOM_API_URL: "https://example.com",
      MY_SERVICE_TOKEN: "safe-token",
    });

    expect(result.CUSTOM_API_URL).toBe("https://example.com");
    expect(result.MY_SERVICE_TOKEN).toBe("safe-token");
  });

  test("filters all dangerous keys simultaneously", () => {
    const allDangerous: Record<string, string> = {};
    for (const key of DANGEROUS_ENV_KEYS) {
      allDangerous[key] = "malicious-value";
    }
    allDangerous.SAFE_KEY = "safe-value";

    const result = filterOptionsEnv(allDangerous);

    for (const key of DANGEROUS_ENV_KEYS) {
      expect(result[key]).toBeUndefined();
    }
    expect(result.SAFE_KEY).toBe("safe-value");
  });

  test("returns empty object for empty options.env", () => {
    const result = filterOptionsEnv({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Combined env construction
// ---------------------------------------------------------------------------

describe("API key subprocess isolation -- combined env", () => {
  test("options.env values are overridden by safeEnv (parent process wins)", () => {
    // In the actual ClaudeCodeManager, the merge is: { ...filteredEnv, ...safeEnv }
    // This means safeEnv (from parent) overrides filteredEnv (from options)
    const filteredEnv = filterOptionsEnv({ ANTHROPIC_API_KEY: "from-options" });
    const safeEnv = buildSafeEnv({ ANTHROPIC_API_KEY: "from-parent" });

    const combined = { ...filteredEnv, ...safeEnv };

    expect(combined.ANTHROPIC_API_KEY).toBe("from-parent");
  });

  test("options.env provides additional vars not in parent env", () => {
    const filteredEnv = filterOptionsEnv({ CUSTOM_VAR: "from-options" });
    const safeEnv = buildSafeEnv({ PATH: "/usr/bin" });

    const combined = { ...filteredEnv, ...safeEnv };

    expect(combined.CUSTOM_VAR).toBe("from-options");
    expect(combined.PATH).toBe("/usr/bin");
  });

  test("full scenario: real-world env construction", () => {
    const parentEnv: Record<string, string> = {
      PATH: "/usr/bin:/usr/local/bin",
      HOME: "/home/eidolon",
      USER: "eidolon",
      LANG: "en_US.UTF-8",
      EIDOLON_MASTER_KEY: "top-secret",
      EIDOLON_GPU_API_KEY: "gpu-secret",
      EIDOLON_CONFIG: "/etc/eidolon/config.json",
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      DATABASE_URL: "postgres://secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    };

    const optionsEnv: Record<string, string> = {
      LD_PRELOAD: "/malicious.so",
      NODE_OPTIONS: "--inspect",
      SESSION_WORKSPACE: "/tmp/workspace",
    };

    const safeEnv = buildSafeEnv(parentEnv);
    const filteredEnv = filterOptionsEnv(optionsEnv);
    const combined = { ...filteredEnv, ...safeEnv };

    // Should have safe keys from parent
    expect(combined.PATH).toBe("/usr/bin:/usr/local/bin");
    expect(combined.HOME).toBe("/home/eidolon");
    expect(combined.USER).toBe("eidolon");
    expect(combined.LANG).toBe("en_US.UTF-8");

    // Should have safe EIDOLON_ and ANTHROPIC_ vars
    expect(combined.EIDOLON_CONFIG).toBe("/etc/eidolon/config.json");
    expect(combined.ANTHROPIC_API_KEY).toBe("sk-ant-real-key");

    // Should NOT have secret env keys
    expect(combined.EIDOLON_MASTER_KEY).toBeUndefined();
    expect(combined.EIDOLON_GPU_API_KEY).toBeUndefined();

    // Should NOT have arbitrary parent env
    expect(combined.DATABASE_URL).toBeUndefined();
    expect(combined.AWS_SECRET_ACCESS_KEY).toBeUndefined();

    // Should NOT have dangerous options.env
    expect(combined.LD_PRELOAD).toBeUndefined();
    expect(combined.NODE_OPTIONS).toBeUndefined();

    // Should have safe options.env
    expect(combined.SESSION_WORKSPACE).toBe("/tmp/workspace");
  });
});
