import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { SafetyClassifier } from "../safety.ts";

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

describe("SafetyClassifier", () => {
  const logger = createSilentLogger();
  const classifier = new SafetyClassifier(logger);

  test("classify returns dangerous for shell commands", () => {
    const result = classifier.classify("Cleanup Script", "Run this to clean up: rm -rf /tmp/old-files", "reddit");

    expect(result.level).toBe("dangerous");
    expect(result.flags).toContain("destructive_command");
    expect(result.reason).toContain("Dangerous");
  });

  test("classify returns needs_approval for code content", () => {
    const result = classifier.classify(
      "TypeScript Pattern",
      "Here's a useful pattern:\n```typescript\nfunction hello(): void {\n  console.log('hi');\n}\n```",
      "hackernews",
    );

    expect(result.level).toBe("needs_approval");
    expect(result.flags).toContain("contains_code_block");
  });

  test("classify returns safe for informational content", () => {
    const result = classifier.classify(
      "AI News Update",
      "A new study was published about large language models and their impact on software development.",
      "rss",
    );

    expect(result.level).toBe("safe");
    expect(result.flags).toHaveLength(0);
  });

  test("classify always flags code as needs_approval minimum", () => {
    // Content with function definitions should not be "safe"
    const result = classifier.classify(
      "Helper Function",
      "export function calculateScore(input: number): number { return input * 2; }",
      "hackernews",
    );

    expect(result.level).not.toBe("safe");
    expect(["needs_approval", "dangerous"]).toContain(result.level);
  });

  test("classify detects credential patterns", () => {
    const result = classifier.classify(
      "Config Example",
      'Set your API key: api_key = "sk-1234567890abcdefghij"',
      "reddit",
    );

    expect(result.level).toBe("dangerous");
    expect(result.flags).toContain("contains_api_key");
  });

  test("classify returns flags array", () => {
    const result = classifier.classify(
      "Docker Setup",
      "Run: sudo docker run -p 8080:80 myimage\nThen: npm install express",
      "hackernews",
    );

    expect(result.level).toBe("dangerous");
    expect(Array.isArray(result.flags)).toBe(true);
    expect(result.flags.length).toBeGreaterThan(0);
    // Should detect sudo
    expect(result.flags).toContain("elevated_privileges");
  });
});
