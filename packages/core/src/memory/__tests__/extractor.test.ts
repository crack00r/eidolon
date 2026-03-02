import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import type { ConversationTurn, ExtractedMemory, LlmExtractFn } from "../extractor.ts";
import { MemoryExtractor } from "../extractor.ts";

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

function makeTurn(overrides?: Partial<ConversationTurn>): ConversationTurn {
  return {
    userMessage: "I prefer dark mode for all my editors",
    assistantResponse: "Got it, I'll keep that in mind.",
    ...overrides,
  };
}

const mockLlm: LlmExtractFn = async () => [
  { type: "fact", content: "mock fact from LLM", confidence: 0.8, tags: ["llm-extracted"], source: "llm" },
];

// ---------------------------------------------------------------------------
// isWorthExtracting
// ---------------------------------------------------------------------------

describe("MemoryExtractor.isWorthExtracting", () => {
  test("returns false for trivial messages", () => {
    expect(MemoryExtractor.isWorthExtracting(makeTurn({ userMessage: "ok", assistantResponse: "👍" }))).toBe(false);
    expect(MemoryExtractor.isWorthExtracting(makeTurn({ userMessage: "thanks", assistantResponse: "Sure!" }))).toBe(
      false,
    );
    expect(MemoryExtractor.isWorthExtracting(makeTurn({ userMessage: "ja", assistantResponse: "klar" }))).toBe(false);
    expect(MemoryExtractor.isWorthExtracting(makeTurn({ userMessage: "danke", assistantResponse: "ok" }))).toBe(false);
  });

  test("returns true for substantive messages", () => {
    expect(
      MemoryExtractor.isWorthExtracting(
        makeTurn({
          userMessage: "I prefer dark mode for all my editors",
          assistantResponse: "Noted! I'll use dark mode settings.",
        }),
      ),
    ).toBe(true);

    expect(
      MemoryExtractor.isWorthExtracting(
        makeTurn({
          userMessage: "Remember that my server runs Ubuntu 22.04",
          assistantResponse: "I'll remember that.",
        }),
      ),
    ).toBe(true);
  });

  test("returns false for empty messages", () => {
    expect(MemoryExtractor.isWorthExtracting(makeTurn({ userMessage: "", assistantResponse: "" }))).toBe(false);
    expect(MemoryExtractor.isWorthExtracting(makeTurn({ userMessage: "  ", assistantResponse: "  " }))).toBe(false);
  });

  test("returns true when user message is trivial but assistant response is substantive", () => {
    expect(
      MemoryExtractor.isWorthExtracting(
        makeTurn({
          userMessage: "ok",
          assistantResponse: "I've updated the configuration to use dark mode for all editors.",
        }),
      ),
    ).toBe(true);
  });

  test("returns false when both messages are very short", () => {
    expect(MemoryExtractor.isWorthExtracting(makeTurn({ userMessage: "hi", assistantResponse: "hey" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractRuleBased
// ---------------------------------------------------------------------------

describe("MemoryExtractor.extractRuleBased", () => {
  const extractor = new MemoryExtractor(createSilentLogger(), { strategy: "rule-based" });

  test("extracts explicit memory requests", () => {
    const results = extractor.extractRuleBased(
      makeTurn({ userMessage: "Remember that my server IP is 192.168.1.100", assistantResponse: "Noted." }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const mem = results.find((r) => r.tags.includes("explicit"));
    expect(mem).toBeDefined();
    expect(mem?.type).toBe("fact");
    expect(mem?.confidence).toBe(0.95);
    expect(mem?.content).toContain("my server IP is 192.168.1.100");
  });

  test("extracts preferences", () => {
    const results = extractor.extractRuleBased(
      makeTurn({ userMessage: "I prefer TypeScript over JavaScript", assistantResponse: "Good choice." }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const pref = results.find((r) => r.type === "preference");
    expect(pref).toBeDefined();
    expect(pref?.content).toContain("TypeScript over JavaScript");
    expect(pref?.confidence).toBe(0.85);
  });

  test("extracts decisions", () => {
    const results = extractor.extractRuleBased(
      makeTurn({ userMessage: "We decided to use PostgreSQL for the main database", assistantResponse: "Understood." }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const decision = results.find((r) => r.type === "decision");
    expect(decision).toBeDefined();
    expect(decision?.content).toContain("PostgreSQL");
    expect(decision?.confidence).toBe(0.9);
  });

  test("extracts corrections", () => {
    const results = extractor.extractRuleBased(
      makeTurn({
        userMessage: "Actually, the deployment runs on port 8080 not 3000",
        assistantResponse: "Thanks for the correction.",
      }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const correction = results.find((r) => r.tags.includes("correction"));
    expect(correction).toBeDefined();
    expect(correction?.type).toBe("fact");
    expect(correction?.confidence).toBe(0.9);
  });

  test("extracts todos", () => {
    const results = extractor.extractRuleBased(
      makeTurn({
        userMessage: "Remind me to update the SSL certificates next week",
        assistantResponse: "I'll remind you.",
      }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const todo = results.find((r) => r.tags.includes("todo"));
    expect(todo).toBeDefined();
    expect(todo?.content).toContain("update the SSL certificates");
  });

  test("extracts personal information", () => {
    const results = extractor.extractRuleBased(
      makeTurn({
        userMessage: "I live in Munich, Germany",
        assistantResponse: "Nice city!",
      }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const personal = results.find((r) => r.tags.includes("personal"));
    expect(personal).toBeDefined();
    expect(personal?.type).toBe("fact");
    expect(personal?.content).toContain("Munich");
  });

  test("handles German patterns", () => {
    const results = extractor.extractRuleBased(
      makeTurn({
        userMessage: "Ich bevorzuge dunkle Themes für alle Editoren",
        assistantResponse: "Verstanden.",
      }),
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    const pref = results.find((r) => r.type === "preference");
    expect(pref).toBeDefined();
    expect(pref?.content).toContain("dunkle Themes");

    const germanMemory = extractor.extractRuleBased(
      makeTurn({
        userMessage: "Merk dir dass mein Server Ubuntu nutzt",
        assistantResponse: "Okay.",
      }),
    );
    expect(germanMemory.length).toBeGreaterThanOrEqual(1);
    const explicit = germanMemory.find((r) => r.tags.includes("explicit"));
    expect(explicit).toBeDefined();
  });

  test("returns empty array for trivial messages", () => {
    const results = extractor.extractRuleBased(makeTurn({ userMessage: "Hello there", assistantResponse: "Hi!" }));

    expect(results).toEqual([]);
  });

  test("deduplicates when same content matches in user and assistant", () => {
    const results = extractor.extractRuleBased(
      makeTurn({
        userMessage: "I prefer using Bun as my runtime",
        assistantResponse: "I prefer using Bun as my runtime",
      }),
    );

    // Should deduplicate to just one entry (the user one with higher confidence)
    const bunPrefs = results.filter((r) => r.content.toLowerCase().includes("bun"));
    expect(bunPrefs).toHaveLength(1);
    expect(bunPrefs[0]?.confidence).toBe(0.85); // User confidence, not assistant's 0.85 * 0.8
  });
});

// ---------------------------------------------------------------------------
// extract() async
// ---------------------------------------------------------------------------

describe("MemoryExtractor.extract", () => {
  test("works with rule-based strategy", async () => {
    const extractor = new MemoryExtractor(createSilentLogger(), { strategy: "rule-based" });
    const result = await extractor.extract(
      makeTurn({ userMessage: "Remember that tests should always pass", assistantResponse: "Noted." }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(1);
    expect(result.value.every((m) => m.source === "rule_based")).toBe(true);
  });

  test("calls LLM function when strategy is hybrid", async () => {
    let llmCalled = false;
    const trackedLlm: LlmExtractFn = async (turn) => {
      llmCalled = true;
      return mockLlm(turn);
    };

    const extractor = new MemoryExtractor(createSilentLogger(), {
      strategy: "hybrid",
      llmExtractFn: trackedLlm,
    });

    const result = await extractor.extract(
      makeTurn({
        userMessage: "I prefer using dark mode everywhere",
        assistantResponse: "I'll keep that in mind.",
      }),
    );

    expect(llmCalled).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have both rule-based and LLM results
    const sources = new Set(result.value.map((m) => m.source));
    expect(sources.has("rule_based")).toBe(true);
    expect(sources.has("llm")).toBe(true);
  });

  test("merges and deduplicates rule + LLM results", async () => {
    // LLM returns same content as rule-based with different confidence
    const duplicatingLlm: LlmExtractFn = async () => [
      {
        type: "preference",
        content: "dark mode everywhere",
        confidence: 0.75,
        tags: ["llm-extracted"],
        source: "llm",
      },
    ];

    const extractor = new MemoryExtractor(createSilentLogger(), {
      strategy: "hybrid",
      llmExtractFn: duplicatingLlm,
    });

    const result = await extractor.extract(
      makeTurn({
        userMessage: "I prefer dark mode everywhere",
        assistantResponse: "Noted.",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The rule-based extraction captures "dark mode everywhere" with confidence 0.85
    // The LLM returns "dark mode everywhere" with confidence 0.75
    // After dedup, the higher-confidence one should win
    const darkModeEntries = result.value.filter((m) => m.content.toLowerCase().includes("dark mode everywhere"));
    expect(darkModeEntries).toHaveLength(1);
    expect(darkModeEntries[0]?.confidence).toBe(0.85); // Rule-based wins
  });

  test("returns empty array for trivial turns", async () => {
    const extractor = new MemoryExtractor(createSilentLogger(), {
      strategy: "hybrid",
      llmExtractFn: mockLlm,
    });

    const result = await extractor.extract(makeTurn({ userMessage: "ok", assistantResponse: "👍" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  test("falls back to rule-based when LLM fails in hybrid mode", async () => {
    const failingLlm: LlmExtractFn = async () => {
      throw new Error("LLM unavailable");
    };

    const extractor = new MemoryExtractor(createSilentLogger(), {
      strategy: "hybrid",
      llmExtractFn: failingLlm,
    });

    const result = await extractor.extract(
      makeTurn({
        userMessage: "Remember that we use Bun for testing",
        assistantResponse: "Noted.",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(1);
    expect(result.value.every((m) => m.source === "rule_based")).toBe(true);
  });

  test("returns error when LLM-only strategy fails", async () => {
    const failingLlm: LlmExtractFn = async () => {
      throw new Error("LLM unavailable");
    };

    const extractor = new MemoryExtractor(createSilentLogger(), {
      strategy: "llm",
      llmExtractFn: failingLlm,
    });

    const result = await extractor.extract(
      makeTurn({
        userMessage: "Remember this important thing about the server",
        assistantResponse: "Noted.",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MEMORY_EXTRACTION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// toCreateInputs
// ---------------------------------------------------------------------------

describe("MemoryExtractor.toCreateInputs", () => {
  test("converts extracted memories to store format", () => {
    const extractor = new MemoryExtractor(createSilentLogger(), { strategy: "rule-based" });

    const extracted: ExtractedMemory[] = [
      { type: "fact", content: "Server runs Ubuntu 22.04", confidence: 0.95, tags: ["explicit"], source: "rule_based" },
      {
        type: "preference",
        content: "dark mode for editors",
        confidence: 0.85,
        tags: ["preference"],
        source: "rule_based",
      },
    ];

    const inputs = extractor.toCreateInputs(extracted, "session-123");

    expect(inputs).toHaveLength(2);

    expect(inputs[0]?.type).toBe("fact");
    expect(inputs[0]?.layer).toBe("short_term");
    expect(inputs[0]?.content).toBe("Server runs Ubuntu 22.04");
    expect(inputs[0]?.confidence).toBe(0.95);
    expect(inputs[0]?.source).toBe("extraction:rule_based");
    expect(inputs[0]?.tags).toEqual(["explicit"]);
    expect(inputs[0]?.metadata).toEqual({ sessionId: "session-123" });

    expect(inputs[1]?.type).toBe("preference");
    expect(inputs[1]?.source).toBe("extraction:rule_based");
  });

  test("omits metadata when no sessionId provided", () => {
    const extractor = new MemoryExtractor(createSilentLogger(), { strategy: "rule-based" });

    const extracted: ExtractedMemory[] = [
      { type: "fact", content: "some important fact here", confidence: 0.9, tags: [], source: "llm" },
    ];

    const inputs = extractor.toCreateInputs(extracted);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.metadata).toBeUndefined();
    expect(inputs[0]?.source).toBe("extraction:llm");
  });
});
