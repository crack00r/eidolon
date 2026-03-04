/**
 * Tests for the LLM system: FakeLLMProvider, ModelRouter, and ToolExecutor.
 */

import { describe, expect, test } from "bun:test";
import type {
  LLMProviderType,
  LLMStreamEvent,
  TaskRequirement,
} from "@eidolon/protocol";
import { FakeLLMProvider } from "@eidolon/test-utils";
import type { Logger } from "../logging/logger.ts";
import { ModelRouter } from "../llm/router.ts";
import { ToolExecutor } from "../llm/tool-executor.ts";

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

/** Collect all events from an async iterable into an array. */
async function collectStream<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// FakeLLMProvider
// ---------------------------------------------------------------------------

describe("FakeLLMProvider", () => {
  test("complete returns configured response", async () => {
    const provider = FakeLLMProvider.withResponse("Hello world");

    const result = await provider.complete([{ role: "user", content: "Hi" }]);

    expect(result.content).toBe("Hello world");
    expect(result.model).toBe("fake-model");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe("Hello world".length);
  });

  test("complete records calls", async () => {
    const provider = new FakeLLMProvider();

    expect(provider.getCallCount()).toBe(0);

    await provider.complete([{ role: "user", content: "First" }]);
    await provider.complete([{ role: "user", content: "Second" }]);

    expect(provider.getCallCount()).toBe(2);

    const calls = provider.getCalls();
    expect(calls[0]?.messages[0]?.content).toBe("First");
    expect(calls[1]?.messages[0]?.content).toBe("Second");
  });

  test("stream yields text and done events by default", async () => {
    const provider = FakeLLMProvider.withResponse("Stream result");

    const events = await collectStream(
      provider.stream([{ role: "user", content: "Go" }]),
    );

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.type).toBe("text");
    expect(events[0]?.text).toBe("Stream result");

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.usage).toBeDefined();
  });

  test("stream yields custom events when configured", async () => {
    const provider = new FakeLLMProvider();

    const customEvents: LLMStreamEvent[] = [
      { type: "text", text: "Part 1 " },
      { type: "text", text: "Part 2" },
      { type: "done", usage: { inputTokens: 20, outputTokens: 10 } },
    ];
    provider.setStreamEvents(customEvents);

    const events = await collectStream(
      provider.stream([{ role: "user", content: "Multi-part" }]),
    );

    expect(events).toHaveLength(3);
    expect(events[0]?.text).toBe("Part 1 ");
    expect(events[1]?.text).toBe("Part 2");
    expect(events[2]?.type).toBe("done");
  });

  test("isAvailable returns true by default", async () => {
    const provider = new FakeLLMProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  test("isAvailable returns false when set unavailable", async () => {
    const provider = FakeLLMProvider.unavailable();
    expect(await provider.isAvailable()).toBe(false);
  });

  test("setAvailable toggles availability", async () => {
    const provider = new FakeLLMProvider();
    expect(await provider.isAvailable()).toBe(true);

    provider.setAvailable(false);
    expect(await provider.isAvailable()).toBe(false);

    provider.setAvailable(true);
    expect(await provider.isAvailable()).toBe(true);
  });

  test("listModels returns configured models", async () => {
    const provider = new FakeLLMProvider();
    expect(await provider.listModels()).toEqual(["fake-model"]);

    provider.setModels(["model-a", "model-b"]);
    expect(await provider.listModels()).toEqual(["model-a", "model-b"]);
  });

  test("constructor sets type and name", () => {
    const claude = new FakeLLMProvider("claude", "Claude Mock");
    expect(claude.type).toBe("claude");
    expect(claude.name).toBe("Claude Mock");

    const ollama = new FakeLLMProvider("ollama", "Ollama Mock");
    expect(ollama.type).toBe("ollama");
  });

  test("withResponse factory sets provider type", () => {
    const provider = FakeLLMProvider.withResponse("test", "claude");
    expect(provider.type).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// ModelRouter
// ---------------------------------------------------------------------------

describe("ModelRouter", () => {
  const logger = createSilentLogger();

  test("registerProvider stores provider", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    const provider = new FakeLLMProvider("ollama", "Test Ollama");

    router.registerProvider(provider);

    expect(router.getProvider("ollama")).toBe(provider);
  });

  test("getAllProviders returns all registered providers", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const ollama = new FakeLLMProvider("ollama", "Ollama");
    const claude = new FakeLLMProvider("claude", "Claude");

    router.registerProvider(ollama);
    router.registerProvider(claude);

    const all = router.getAllProviders();
    expect(all).toHaveLength(2);
  });

  test("route returns only registered providers from chain", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    const claude = new FakeLLMProvider("claude", "Claude");
    router.registerProvider(claude);

    // conversation defaults to ["claude"] in DEFAULT_ROUTING
    const task: TaskRequirement = { type: "conversation" };
    const chain = router.route(task);

    expect(chain).toEqual(["claude"]);
  });

  test("route for extraction includes local-first providers", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const ollama = new FakeLLMProvider("ollama", "Ollama");
    const claude = new FakeLLMProvider("claude", "Claude");
    router.registerProvider(ollama);
    router.registerProvider(claude);

    // extraction defaults to ["ollama", "llamacpp", "claude"]
    const task: TaskRequirement = { type: "extraction" };
    const chain = router.route(task);

    // Only registered providers are returned, llamacpp is filtered out
    expect(chain).toEqual(["ollama", "claude"]);
  });

  test("route filters out unregistered providers", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    const claude = new FakeLLMProvider("claude", "Claude");
    router.registerProvider(claude);

    // extraction defaults to ["ollama", "llamacpp", "claude"]
    const task: TaskRequirement = { type: "extraction" };
    const chain = router.route(task);

    // Only claude is registered
    expect(chain).toEqual(["claude"]);
  });

  test("route returns empty array when no providers registered for task", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    // No providers registered at all
    const task: TaskRequirement = { type: "conversation" };
    const chain = router.route(task);
    expect(chain).toEqual([]);
  });

  test("route uses user-configured routing overrides", () => {
    const customRouting: Record<string, readonly LLMProviderType[]> = {
      conversation: ["ollama", "claude"],
    };
    const router = new ModelRouter({ providers: {}, routing: customRouting }, logger);

    const ollama = new FakeLLMProvider("ollama", "Ollama");
    const claude = new FakeLLMProvider("claude", "Claude");
    router.registerProvider(ollama);
    router.registerProvider(claude);

    const task: TaskRequirement = { type: "conversation" };
    const chain = router.route(task);

    expect(chain).toEqual(["ollama", "claude"]);
  });

  test("selectProvider returns first available provider", async () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const unavailableOllama = FakeLLMProvider.unavailable("ollama");
    const claude = FakeLLMProvider.withResponse("I am Claude", "claude");
    router.registerProvider(unavailableOllama);
    router.registerProvider(claude);

    // extraction: ollama (unavailable) -> llamacpp (not registered) -> claude (available)
    const task: TaskRequirement = { type: "extraction" };
    const selected = await router.selectProvider(task);

    expect(selected).toBeDefined();
    expect(selected?.type).toBe("claude");
  });

  test("selectProvider returns undefined when no providers available", async () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const unavailable = FakeLLMProvider.unavailable("claude");
    router.registerProvider(unavailable);

    const task: TaskRequirement = { type: "conversation" };
    const selected = await router.selectProvider(task);

    expect(selected).toBeUndefined();
  });

  test("selectProvider returns first available in chain (local first)", async () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const ollama = FakeLLMProvider.withResponse("Local response", "ollama");
    const claude = FakeLLMProvider.withResponse("Claude response", "claude");
    router.registerProvider(ollama);
    router.registerProvider(claude);

    // extraction: ollama (available) should be chosen first
    const task: TaskRequirement = { type: "extraction" };
    const selected = await router.selectProvider(task);

    expect(selected).toBeDefined();
    expect(selected?.type).toBe("ollama");
  });

  test("selectProvider falls back when local provider unavailable", async () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const ollama = FakeLLMProvider.unavailable("ollama");
    const claude = FakeLLMProvider.withResponse("Fallback", "claude");
    router.registerProvider(ollama);
    router.registerProvider(claude);

    // filtering: ollama (unavailable) -> llamacpp (not registered) -> claude (available)
    const task: TaskRequirement = { type: "filtering" };
    const selected = await router.selectProvider(task);

    expect(selected?.type).toBe("claude");
  });

  test("code-generation routes to claude only", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const ollama = new FakeLLMProvider("ollama", "Ollama");
    const claude = new FakeLLMProvider("claude", "Claude");
    router.registerProvider(ollama);
    router.registerProvider(claude);

    const task: TaskRequirement = { type: "code-generation" };
    const chain = router.route(task);

    // code-generation defaults to ["claude"]
    expect(chain).toEqual(["claude"]);
  });

  test("embedding routes to local providers only", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);

    const ollama = new FakeLLMProvider("ollama", "Ollama");
    const claude = new FakeLLMProvider("claude", "Claude");
    router.registerProvider(ollama);
    router.registerProvider(claude);

    const task: TaskRequirement = { type: "embedding" };
    const chain = router.route(task);

    // embedding defaults to ["ollama", "llamacpp"] -- claude not included
    expect(chain).toEqual(["ollama"]);
  });

  test("getProvider returns undefined for unregistered type", () => {
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    expect(router.getProvider("llamacpp")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

describe("ToolExecutor", () => {
  const logger = createSilentLogger();

  test("registerTool and execute returns successful result", async () => {
    const executor = new ToolExecutor(logger);

    executor.registerTool("greet", async (args) => {
      return `Hello, ${String(args["name"])}!`;
    });

    const result = await executor.execute(
      { id: "call-1", name: "greet", arguments: { name: "Manuel" } },
      [],
    );

    expect(result.toolCallId).toBe("call-1");
    expect(result.content).toBe("Hello, Manuel!");
    expect(result.isError).toBeUndefined();
  });

  test("execute returns error for unknown tool", async () => {
    const executor = new ToolExecutor(logger);

    const result = await executor.execute(
      { id: "call-2", name: "nonexistent", arguments: {} },
      [],
    );

    expect(result.toolCallId).toBe("call-2");
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"nonexistent" not found');
  });

  test("execute handles tool implementation error", async () => {
    const executor = new ToolExecutor(logger);

    executor.registerTool("boom", async () => {
      throw new Error("Tool exploded");
    });

    const result = await executor.execute(
      { id: "call-3", name: "boom", arguments: {} },
      [],
    );

    expect(result.toolCallId).toBe("call-3");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Tool execution error");
    expect(result.content).toContain("Tool exploded");
  });

  test("multiple tools can be registered and executed independently", async () => {
    const executor = new ToolExecutor(logger);

    executor.registerTool("add", async (args) => {
      const a = Number(args["a"]);
      const b = Number(args["b"]);
      return String(a + b);
    });

    executor.registerTool("multiply", async (args) => {
      const a = Number(args["a"]);
      const b = Number(args["b"]);
      return String(a * b);
    });

    const addResult = await executor.execute(
      { id: "add-1", name: "add", arguments: { a: 3, b: 4 } },
      [],
    );
    expect(addResult.content).toBe("7");
    expect(addResult.isError).toBeUndefined();

    const mulResult = await executor.execute(
      { id: "mul-1", name: "multiply", arguments: { a: 5, b: 6 } },
      [],
    );
    expect(mulResult.content).toBe("30");
    expect(mulResult.isError).toBeUndefined();
  });

  test("registering a tool with the same name overwrites the previous one", async () => {
    const executor = new ToolExecutor(logger);

    executor.registerTool("versioned", async () => "v1");
    const result1 = await executor.execute(
      { id: "v1", name: "versioned", arguments: {} },
      [],
    );
    expect(result1.content).toBe("v1");

    executor.registerTool("versioned", async () => "v2");
    const result2 = await executor.execute(
      { id: "v2", name: "versioned", arguments: {} },
      [],
    );
    expect(result2.content).toBe("v2");
  });

  test("tool receives correct arguments", async () => {
    const executor = new ToolExecutor(logger);
    let receivedArgs: Record<string, unknown> = {};

    executor.registerTool("capture", async (args) => {
      receivedArgs = args;
      return "ok";
    });

    await executor.execute(
      {
        id: "cap-1",
        name: "capture",
        arguments: { key: "value", num: 42, nested: { a: 1 } },
      },
      [],
    );

    expect(receivedArgs["key"]).toBe("value");
    expect(receivedArgs["num"]).toBe(42);
    expect(receivedArgs["nested"]).toEqual({ a: 1 });
  });
});
