import { describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Err, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { ImplementationPipeline, type ImplementFn, type RunCommandFn, sanitizeBranchName } from "../implementation.ts";

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

function createMockRunCommand(override?: Partial<Record<string, { stdout: string; exitCode: number }>>): RunCommandFn {
  return async (cmd: string): Promise<Result<{ stdout: string; exitCode: number }, EidolonError>> => {
    if (override) {
      for (const [key, value] of Object.entries(override)) {
        if (cmd.includes(key) && value) {
          return Ok(value);
        }
      }
    }
    return Ok({ stdout: `OK: ${cmd}`, exitCode: 0 });
  };
}

function createMockImplement(result?: Result<string, EidolonError>): ImplementFn {
  return async (): Promise<Result<string, EidolonError>> => {
    return result ?? Ok("Implementation complete");
  };
}

describe("ImplementationPipeline", () => {
  const logger = createSilentLogger();

  test("run executes all steps successfully", async () => {
    const pipeline = new ImplementationPipeline(logger);

    const result = await pipeline.run({
      discoveryId: "abc12345-6789",
      title: "Improve error handling",
      content: "Add retry logic to HTTP calls",
      workspaceDir: "/tmp/workspace",
      implementFn: createMockImplement(),
      runCommandFn: createMockRunCommand(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const impl = result.value;
    expect(impl.success).toBe(true);
    expect(impl.discoveryId).toBe("abc12345-6789");
    expect(impl.branch).toBe("learning/abc12345-improve-error-handling");
    expect(impl.steps).toHaveLength(4);
    expect(impl.steps.every((s) => s.status === "passed")).toBe(true);
    expect(impl.prDescription).toBeDefined();
    expect(impl.prDescription).toContain("Self-Learning Implementation");
    expect(impl.prDescription).toContain("Improve error handling");
  });

  test("run reports failure when branch creation fails", async () => {
    const pipeline = new ImplementationPipeline(logger);

    const failingRunCommand: RunCommandFn = async (cmd) => {
      if (cmd.includes("git checkout")) {
        return Ok({ stdout: "fatal: branch already exists", exitCode: 128 });
      }
      return Ok({ stdout: "OK", exitCode: 0 });
    };

    const result = await pipeline.run({
      discoveryId: "def12345-6789",
      title: "Some change",
      content: "Details",
      workspaceDir: "/tmp/workspace",
      implementFn: createMockImplement(),
      runCommandFn: failingRunCommand,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const impl = result.value;
    expect(impl.success).toBe(false);
    expect(impl.error).toBe("Failed to create branch");
    expect(impl.steps).toHaveLength(1);
    expect(impl.steps[0]?.status).toBe("failed");
    expect(impl.steps[0]?.name).toBe("create_branch");
  });

  test("run reports failure when implementation fails", async () => {
    const pipeline = new ImplementationPipeline(logger);

    const failingImpl = createMockImplement(
      Err({
        code: "CLAUDE_PROCESS_CRASHED",
        message: "Claude process crashed",
        timestamp: Date.now(),
      }),
    );

    const result = await pipeline.run({
      discoveryId: "ghi12345-6789",
      title: "Another change",
      content: "Details",
      workspaceDir: "/tmp/workspace",
      implementFn: failingImpl,
      runCommandFn: createMockRunCommand(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const impl = result.value;
    expect(impl.success).toBe(false);
    expect(impl.error).toBe("Implementation failed");
    expect(impl.steps).toHaveLength(2); // branch + implement
    expect(impl.steps[0]?.status).toBe("passed"); // branch succeeded
    expect(impl.steps[1]?.status).toBe("failed"); // implement failed
    expect(impl.steps[1]?.name).toBe("implement");
  });

  test("run reports failure when tests fail", async () => {
    const pipeline = new ImplementationPipeline(logger);

    const runCommandWithTestFailure: RunCommandFn = async (cmd) => {
      if (cmd.includes("pnpm -r test")) {
        return Ok({ stdout: "FAIL: 3 tests failed", exitCode: 1 });
      }
      return Ok({ stdout: `OK: ${cmd}`, exitCode: 0 });
    };

    const result = await pipeline.run({
      discoveryId: "jkl12345-6789",
      title: "Risky change",
      content: "Might break things",
      workspaceDir: "/tmp/workspace",
      implementFn: createMockImplement(),
      runCommandFn: runCommandWithTestFailure,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const impl = result.value;
    expect(impl.success).toBe(false);
    expect(impl.prDescription).toBeUndefined();
    expect(impl.steps).toHaveLength(4);

    const testStep = impl.steps.find((s) => s.name === "test");
    expect(testStep).toBeDefined();
    expect(testStep?.status).toBe("failed");
  });

  test("generateBranchName creates valid branch names", () => {
    // Basic case
    expect(ImplementationPipeline.generateBranchName("abc12345-long-id", "Improve error handling")).toBe(
      "learning/abc12345-improve-error-handling",
    );

    // Special characters are slugified
    expect(ImplementationPipeline.generateBranchName("xyz99999", "Fix: the bug!! (urgent)")).toBe(
      "learning/xyz99999-fix-the-bug-urgent",
    );

    // Long titles are truncated
    const longTitle = "This is a very long title that should be truncated to fit within the maximum branch name length";
    const branch = ImplementationPipeline.generateBranchName("abcdefgh", longTitle);
    // Slug part should be at most 50 chars
    const slugPart = branch.replace("learning/abcdefgh-", "");
    expect(slugPart.length).toBeLessThanOrEqual(50);
    expect(branch.startsWith("learning/abcdefgh-")).toBe(true);
  });

  test("generatePrDescription includes all sections", () => {
    const steps = [
      { name: "create_branch", status: "passed" as const, output: "OK" },
      { name: "implement", status: "passed" as const, output: "Done" },
      { name: "lint", status: "passed" as const, output: "No errors" },
      { name: "test", status: "passed" as const, output: "All passed" },
    ];

    const pr = ImplementationPipeline.generatePrDescription(
      "Add caching layer",
      "Implement LRU cache for frequently accessed data",
      steps,
    );

    expect(pr).toContain("## Self-Learning Implementation");
    expect(pr).toContain("### Discovery");
    expect(pr).toContain("Add caching layer");
    expect(pr).toContain("### What Changed");
    expect(pr).toContain("LRU cache");
    expect(pr).toContain("### Verification");
    expect(pr).toContain("[x] Lint passed");
    expect(pr).toContain("[x] Tests passed");
    expect(pr).toContain("### Source");
    expect(pr).toContain("manual review and approval");
  });
});

describe("sanitizeBranchName", () => {
  test("passes through safe strings unchanged", () => {
    expect(sanitizeBranchName("abc12345")).toBe("abc12345");
    expect(sanitizeBranchName("my-branch.v2")).toBe("my-branch.v2");
    expect(sanitizeBranchName("under_score")).toBe("under_score");
  });

  test("strips shell injection: semicolon + command", () => {
    const result = sanitizeBranchName("; rm -rf /");
    expect(result).not.toContain(";");
    expect(result).not.toContain(" ");
    expect(result).toBe("rm-rf");
  });

  test("strips shell injection: $() command substitution", () => {
    const result = sanitizeBranchName("$(whoami)");
    expect(result).not.toContain("$");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
    expect(result).toBe("whoami");
  });

  test("strips shell injection: backtick command substitution", () => {
    const result = sanitizeBranchName("`id`");
    expect(result).not.toContain("`");
    expect(result).toBe("id");
  });

  test("strips shell injection: pipe and redirect", () => {
    const result = sanitizeBranchName("foo|bar>baz");
    expect(result).not.toContain("|");
    expect(result).not.toContain(">");
    expect(result).toBe("foo-bar-baz");
  });

  test("strips shell injection: newline injection", () => {
    const result = sanitizeBranchName("safe\n; malicious");
    expect(result).not.toContain("\n");
    expect(result).toBe("safe-malicious");
  });

  test("strips shell injection: ampersand background execution", () => {
    const result = sanitizeBranchName("foo && rm -rf /");
    expect(result).not.toContain("&");
    expect(result).toBe("foo-rm-rf");
  });

  test("strips shell injection: single and double quotes", () => {
    const result = sanitizeBranchName('it\'s a "test"');
    expect(result).not.toContain("'");
    expect(result).not.toContain('"');
    expect(result).toBe("it-s-a-test");
  });

  test("collapses multiple consecutive hyphens", () => {
    expect(sanitizeBranchName("a---b")).toBe("a-b");
    expect(sanitizeBranchName("!@#$%^")).toBe("");
  });

  test("trims leading and trailing hyphens", () => {
    expect(sanitizeBranchName("-leading")).toBe("leading");
    expect(sanitizeBranchName("trailing-")).toBe("trailing");
    expect(sanitizeBranchName("---both---")).toBe("both");
  });

  test("limits length to 60 characters", () => {
    const long = "a".repeat(100);
    expect(sanitizeBranchName(long).length).toBeLessThanOrEqual(60);
  });

  test("returns empty string for entirely unsafe input", () => {
    expect(sanitizeBranchName("!@#$%^&*()")).toBe("");
    expect(sanitizeBranchName("   ")).toBe("");
  });
});

describe("generateBranchName with malicious inputs", () => {
  test("sanitizes discoveryId containing shell metacharacters", () => {
    const branch = ImplementationPipeline.generateBranchName("; rm -rf /", "safe title");
    expect(branch).not.toContain(";");
    expect(branch).not.toContain(" ");
    expect(branch).toMatch(/^learning\/[a-zA-Z0-9._-]+-[a-z0-9-]+$/);
  });

  test("sanitizes discoveryId with command substitution", () => {
    const branch = ImplementationPipeline.generateBranchName("$(curl evil.com)", "test");
    expect(branch).not.toContain("$");
    expect(branch).not.toContain("(");
    expect(branch).toMatch(/^learning\//);
  });

  test("sanitizes discoveryId with backtick injection", () => {
    const branch = ImplementationPipeline.generateBranchName("`whoami`x", "test");
    expect(branch).not.toContain("`");
    expect(branch).toMatch(/^learning\//);
  });

  test("handles both malicious discoveryId and title", () => {
    const branch = ImplementationPipeline.generateBranchName("$(evil)", "; DROP TABLE memories;--");
    expect(branch).not.toContain("$");
    expect(branch).not.toContain(";");
    expect(branch).not.toContain(" ");
    expect(branch).toMatch(/^learning\//);
  });

  test("handles completely unsafe inputs with fallback", () => {
    const branch = ImplementationPipeline.generateBranchName("!@#$%^&*()", "!@#$%^&*()");
    expect(branch).toMatch(/^learning\/discovery-\d+$/);
  });
});
