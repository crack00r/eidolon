import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LogEntry, LoggingConfig } from "@eidolon/protocol";
import { formatLogEntry } from "../formatter.js";
import { createLogger } from "../logger.js";

function captureStdout(): { getOutput: () => string; restore: () => void } {
  let output = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  return {
    getOutput: () => output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function makeConfig(overrides: Partial<LoggingConfig> = {}): LoggingConfig {
  return {
    level: "debug",
    format: "json",
    directory: "",
    maxSizeMb: 50,
    maxFiles: 10,
    ...overrides,
  };
}

describe("createLogger", () => {
  let capture: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    capture = captureStdout();
  });

  afterEach(() => {
    capture.restore();
  });

  test("outputs JSON with correct fields", () => {
    const logger = createLogger(makeConfig());
    logger.info("core", "hello world", { key: "value" });

    const output = capture.getOutput().trim();
    const parsed = JSON.parse(output) as LogEntry;

    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("core");
    expect(parsed.message).toBe("hello world");
    expect(parsed.data).toEqual({ key: "value" });
    expect(typeof parsed.timestamp).toBe("number");
  });

  test("respects log level filtering -- debug dropped when level=info", () => {
    const logger = createLogger(makeConfig({ level: "info" }));
    logger.debug("core", "this should not appear");

    expect(capture.getOutput()).toBe("");
  });

  test("allows messages at or above configured level", () => {
    const logger = createLogger(makeConfig({ level: "warn" }));
    logger.warn("core", "warning");
    logger.error("core", "error");

    const lines = capture.getOutput().trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("child() prepends module prefix", () => {
    const logger = createLogger(makeConfig());
    const child = logger.child("core");
    child.info("config", "loaded");

    const parsed = JSON.parse(capture.getOutput().trim()) as LogEntry;
    expect(parsed.module).toBe("core:config");
  });

  test("nested child() chains module prefixes", () => {
    const logger = createLogger(makeConfig());
    const child = logger.child("core").child("config");
    child.info("loader", "parsing");

    const parsed = JSON.parse(capture.getOutput().trim()) as LogEntry;
    expect(parsed.module).toBe("core:config:loader");
  });

  test("error() normalizes Error objects", () => {
    const logger = createLogger(makeConfig());
    const err = new Error("something broke");
    logger.error("core", "failure", err);

    const parsed = JSON.parse(capture.getOutput().trim()) as LogEntry;
    expect(parsed.error?.message).toBe("something broke");
    expect(parsed.error?.stack).toBeDefined();
  });

  test("error() handles string errors", () => {
    const logger = createLogger(makeConfig());
    logger.error("core", "failure", "string error");

    const parsed = JSON.parse(capture.getOutput().trim()) as LogEntry;
    expect(parsed.error?.message).toBe("string error");
  });

  test("error() handles non-Error unknown objects", () => {
    const logger = createLogger(makeConfig());
    logger.error("core", "failure", 42);

    const parsed = JSON.parse(capture.getOutput().trim()) as LogEntry;
    expect(parsed.error?.message).toBe("42");
  });

  test("error() includes additional data alongside error", () => {
    const logger = createLogger(makeConfig());
    logger.error("core", "failure", new Error("oops"), { context: "startup" });

    const parsed = JSON.parse(capture.getOutput().trim()) as LogEntry;
    expect(parsed.error?.message).toBe("oops");
    expect(parsed.data).toEqual({ context: "startup" });
  });

  test("omits data field when no data provided", () => {
    const logger = createLogger(makeConfig());
    logger.info("core", "no data");

    const parsed = JSON.parse(capture.getOutput().trim()) as LogEntry;
    expect(parsed.data).toBeUndefined();
  });
});

describe("formatLogEntry", () => {
  const entry: LogEntry = {
    level: "info",
    timestamp: 1772540400000, // fixed timestamp
    module: "core:config",
    message: "Config loaded",
    data: { path: "/etc/eidolon/eidolon.json" },
  };

  test("JSON format produces valid JSON", () => {
    const output = formatLogEntry(entry, "json");
    const parsed = JSON.parse(output) as LogEntry;
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("core:config");
  });

  test("pretty format includes all fields", () => {
    const output = formatLogEntry(entry, "pretty");
    expect(output).toContain("INFO");
    expect(output).toContain("core:config");
    expect(output).toContain("Config loaded");
    expect(output).toContain("/etc/eidolon/eidolon.json");
  });

  test("pretty format includes error details", () => {
    const entryWithError: LogEntry = {
      ...entry,
      error: { message: "file not found", stack: "at loader.ts:42" },
    };
    const output = formatLogEntry(entryWithError, "pretty");
    expect(output).toContain("Error: file not found");
    expect(output).toContain("at loader.ts:42");
  });
});
