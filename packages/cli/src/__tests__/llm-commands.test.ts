/**
 * Tests for the LLM CLI command helpers.
 */

import { describe, expect, test } from "bun:test";
import type { LLMConfig } from "@eidolon/protocol";
import { buildProviderList, buildRoutingTable, testProvider } from "../commands/llm.ts";

// ---------------------------------------------------------------------------
// Minimal config factory
// ---------------------------------------------------------------------------

function makeLlmConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    providers: {
      ollama: undefined,
      llamacpp: undefined,
      ...overrides.providers,
    },
    routing: overrides.routing ?? {},
  } as LLMConfig;
}

// ---------------------------------------------------------------------------
// buildProviderList
// ---------------------------------------------------------------------------

describe("buildProviderList", () => {
  test("always includes claude as configured", () => {
    const config = makeLlmConfig();
    const rows = buildProviderList(config);

    const claude = rows.find((r) => r.Provider === "claude");
    expect(claude).toBeDefined();
    expect(claude?.Status).toBe("configured");
    expect(claude?.Details).toContain("Primary provider");
  });

  test("shows ollama as not configured when missing", () => {
    const config = makeLlmConfig();
    const rows = buildProviderList(config);

    const ollama = rows.find((r) => r.Provider === "ollama");
    expect(ollama).toBeDefined();
    expect(ollama?.Status).toBe("not configured");
    expect(ollama?.Details).toContain("eidolon.json");
  });

  test("shows ollama as configured when enabled", () => {
    const config = makeLlmConfig({
      providers: {
        ollama: {
          enabled: true,
          host: "http://localhost:11434",
          defaultModel: "llama3.2",
          models: {
            llama3: { contextLength: 8192, supportsTools: false },
            mistral: { contextLength: 8192, supportsTools: false },
          },
        },
      },
    });
    const rows = buildProviderList(config);

    const ollama = rows.find((r) => r.Provider === "ollama");
    expect(ollama?.Status).toBe("configured");
    expect(ollama?.Details).toContain("llama3, mistral");
  });

  test("shows llamacpp as disabled when present but not enabled", () => {
    const config = makeLlmConfig({
      providers: {
        llamacpp: {
          enabled: false,
          port: 8080,
          modelPath: "/models/test.gguf",
          contextLength: 8192,
          serverPath: "",
          gpuLayers: 0,
        },
      },
    });
    const rows = buildProviderList(config);

    const llamacpp = rows.find((r) => r.Provider === "llamacpp");
    expect(llamacpp?.Status).toBe("disabled");
    expect(llamacpp?.Details).toBe("disabled in config");
  });
});

// ---------------------------------------------------------------------------
// buildRoutingTable
// ---------------------------------------------------------------------------

describe("buildRoutingTable", () => {
  test("includes default routing tasks", () => {
    const config = makeLlmConfig();
    const rows = buildRoutingTable(config);

    const tasks = rows.map((r) => r.Task);
    expect(tasks).toContain("conversation");
    expect(tasks).toContain("extraction");
    expect(tasks).toContain("embedding");
  });

  test("shows chain as arrow-separated providers", () => {
    const config = makeLlmConfig();
    const rows = buildRoutingTable(config);

    const extraction = rows.find((r) => r.Task === "extraction");
    expect(extraction?.Chain).toBe("ollama -> llamacpp -> claude");
  });

  test("custom routing overrides defaults", () => {
    const config = makeLlmConfig({
      routing: {
        conversation: ["llamacpp"],
      },
    });
    const rows = buildRoutingTable(config);

    const conversation = rows.find((r) => r.Task === "conversation");
    expect(conversation?.Chain).toBe("llamacpp");
  });
});

// ---------------------------------------------------------------------------
// testProvider
// ---------------------------------------------------------------------------

describe("testProvider", () => {
  test("claude returns ok with CLI message", async () => {
    const config = makeLlmConfig();
    const result = await testProvider("claude", config);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Claude Code CLI");
  });

  test("ollama returns error when not configured", async () => {
    const config = makeLlmConfig();
    const result = await testProvider("ollama", config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not configured");
  });

  test("unknown provider returns error", async () => {
    const config = makeLlmConfig();
    const result = await testProvider("unknown-provider", config);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Unknown provider");
  });
});
