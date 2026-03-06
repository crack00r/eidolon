import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { splitSentencesMultilingual, TtsChunker } from "../tts-chunker.ts";

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

const logger = createSilentLogger();

describe("splitSentencesMultilingual", () => {
  test("splits English sentences using Intl.Segmenter", () => {
    const text = "Hello world. How are you? I am fine!";
    const sentences = splitSentencesMultilingual(text, "en");

    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences[0]).toContain("Hello world");
    expect(sentences[1]).toContain("How are you");
    expect(sentences[2]).toContain("I am fine");
  });

  test("splits German sentences correctly", () => {
    const text = "Guten Tag. Wie geht es Ihnen? Mir geht es gut.";
    const sentences = splitSentencesMultilingual(text, "de");

    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences[0]).toContain("Guten Tag");
    expect(sentences[1]).toContain("Wie geht es Ihnen");
  });

  test("returns single element for text without sentence boundary", () => {
    const text = "Hello world";
    const sentences = splitSentencesMultilingual(text, "en");

    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toBe("Hello world");
  });

  test("filters out empty segments", () => {
    const text = "  Hello.   ";
    const sentences = splitSentencesMultilingual(text, "en");

    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

describe("TtsChunker", () => {
  test("accumulates tokens and dispatches complete sentences", async () => {
    const chunker = new TtsChunker(logger, { locale: "en", minSentenceLength: 3, maxBufferLength: 2000 });
    const dispatched: string[] = [];
    const cb = async (sentence: string, _index: number): Promise<void> => {
      dispatched.push(sentence);
    };

    await chunker.addToken("Hello world. ", cb);
    await chunker.addToken("How are you?", cb);

    // At least the first sentence should have been dispatched
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0]).toContain("Hello world");
  });

  test("flush sends remaining buffered text", async () => {
    const chunker = new TtsChunker(logger, { locale: "en", minSentenceLength: 3, maxBufferLength: 2000 });
    const dispatched: string[] = [];
    const cb = async (sentence: string, _index: number): Promise<void> => {
      dispatched.push(sentence);
    };

    await chunker.addToken("Partial sentence", cb);
    const count = await chunker.flush(cb);

    expect(count).toBe(1);
    expect(dispatched).toContain("Partial sentence");
  });

  test("flush does not dispatch text shorter than minSentenceLength", async () => {
    const chunker = new TtsChunker(logger, { locale: "en", minSentenceLength: 10, maxBufferLength: 2000 });
    const dispatched: string[] = [];
    const cb = async (sentence: string, _index: number): Promise<void> => {
      dispatched.push(sentence);
    };

    await chunker.addToken("Hi", cb);
    const count = await chunker.flush(cb);

    expect(count).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  test("abort stops dispatching", async () => {
    const chunker = new TtsChunker(logger, { locale: "en", minSentenceLength: 3, maxBufferLength: 2000 });
    const dispatched: string[] = [];
    const cb = async (sentence: string, _index: number): Promise<void> => {
      dispatched.push(sentence);
    };

    chunker.abort();
    await chunker.addToken("Hello world. This is a test.", cb);
    const flushed = await chunker.flush(cb);

    expect(dispatched).toHaveLength(0);
    expect(flushed).toBe(0);
  });

  test("reset clears buffer and allows reuse", async () => {
    const chunker = new TtsChunker(logger, { locale: "en", minSentenceLength: 3, maxBufferLength: 2000 });
    const dispatched: string[] = [];
    const cb = async (sentence: string, _index: number): Promise<void> => {
      dispatched.push(sentence);
    };

    await chunker.addToken("First session text", cb);
    chunker.reset();

    expect(chunker.currentBuffer).toBe("");

    await chunker.addToken("Second session. Done.", cb);
    await chunker.flush(cb);

    // Should have at least dispatched "Second session" or the flushed remainder
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
  });

  test("force flushes when buffer exceeds maxBufferLength", async () => {
    const chunker = new TtsChunker(logger, { locale: "en", minSentenceLength: 3, maxBufferLength: 20 });
    const dispatched: string[] = [];
    const cb = async (sentence: string, _index: number): Promise<void> => {
      dispatched.push(sentence);
    };

    // This token alone exceeds the 20-char maxBufferLength
    const count = await chunker.addToken("This is a long text that exceeds the maximum buffer length", cb);

    expect(count).toBe(1);
    expect(dispatched).toHaveLength(1);
    expect(chunker.currentBuffer).toBe("");
  });

  test("processFullText dispatches all sentences at once", async () => {
    const chunker = new TtsChunker(logger, { locale: "en", minSentenceLength: 3, maxBufferLength: 2000 });
    const dispatched: Array<{ sentence: string; index: number }> = [];
    const cb = async (sentence: string, index: number): Promise<void> => {
      dispatched.push({ sentence, index });
    };

    const result = await chunker.processFullText("First sentence. Second sentence. Third.", cb);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeGreaterThanOrEqual(2);
    }
    // Sentence indices should be sequential
    for (let i = 1; i < dispatched.length; i++) {
      const prev = dispatched[i - 1];
      const curr = dispatched[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr.index).toBe(prev.index + 1);
      }
    }
  });

  test("locale getter returns configured locale", () => {
    const chunker = new TtsChunker(logger, { locale: "de-DE", minSentenceLength: 3, maxBufferLength: 2000 });
    expect(chunker.locale).toBe("de-DE");
  });
});
