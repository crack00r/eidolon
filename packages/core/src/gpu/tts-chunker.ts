/**
 * Streaming TTS chunker -- accumulates tokens and dispatches sentence-level
 * TTS requests using Intl.Segmenter for multilingual sentence boundary detection.
 *
 * Supports streaming token-by-token input from Claude responses, detects
 * sentence boundaries for German, English, and other languages, and dispatches
 * each completed sentence to a TTS callback independently.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback invoked for each completed sentence. */
export type SentenceCallback = (sentence: string, index: number) => Promise<void>;

/** Configuration for the TTS chunker. */
export interface TtsChunkerConfig {
  /** BCP 47 locale for Intl.Segmenter (e.g. "en", "de", "de-DE"). Default: "en". */
  readonly locale: string;
  /** Minimum sentence length to dispatch (avoids sending single-word fragments). Default: 3. */
  readonly minSentenceLength: number;
  /** Maximum buffer length before force-flushing. Default: 2000. */
  readonly maxBufferLength: number;
}

const DEFAULT_CONFIG: TtsChunkerConfig = {
  locale: "en",
  minSentenceLength: 3,
  maxBufferLength: 2000,
};

// ---------------------------------------------------------------------------
// TtsChunker
// ---------------------------------------------------------------------------

export class TtsChunker {
  private buffer = "";
  private sentenceIndex = 0;
  private readonly config: TtsChunkerConfig;
  private readonly logger: Logger;
  private aborted = false;

  constructor(logger: Logger, config?: Partial<TtsChunkerConfig>) {
    this.logger = logger.child("tts-chunker");
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Get the current locale used for segmentation. */
  get locale(): string {
    return this.config.locale;
  }

  /** Get the current buffer contents (for testing/debugging). */
  get currentBuffer(): string {
    return this.buffer;
  }

  /**
   * Feed a token (streaming text fragment) into the chunker.
   * When a complete sentence is detected, `onSentence` is called.
   * Returns the number of sentences dispatched.
   */
  async addToken(token: string, onSentence: SentenceCallback): Promise<number> {
    if (this.aborted) return 0;

    this.buffer += token;
    let dispatched = 0;

    // Force flush if buffer is too long
    if (this.buffer.length >= this.config.maxBufferLength) {
      const sentence = this.buffer.trim();
      if (sentence.length >= this.config.minSentenceLength) {
        await onSentence(sentence, this.sentenceIndex++);
        dispatched++;
      }
      this.buffer = "";
      return dispatched;
    }

    // Use Intl.Segmenter to detect sentence boundaries
    const sentences = splitSentencesMultilingual(this.buffer, this.config.locale);

    // If we have more than one segment, all but the last are complete sentences
    if (sentences.length > 1) {
      for (let i = 0; i < sentences.length - 1; i++) {
        if (this.aborted) break;
        const sentence = sentences[i];
        if (sentence !== undefined && sentence.length >= this.config.minSentenceLength) {
          await onSentence(sentence, this.sentenceIndex++);
          dispatched++;
        }
      }
      // Keep the last (potentially incomplete) segment in the buffer
      this.buffer = sentences[sentences.length - 1] ?? "";
    }

    return dispatched;
  }

  /**
   * Flush any remaining text in the buffer as a final sentence.
   * Call this when the streaming response is complete.
   */
  async flush(onSentence: SentenceCallback): Promise<number> {
    if (this.aborted) return 0;

    const remaining = this.buffer.trim();
    this.buffer = "";

    if (remaining.length >= this.config.minSentenceLength) {
      await onSentence(remaining, this.sentenceIndex++);
      return 1;
    }

    return 0;
  }

  /** Abort the chunker (stop dispatching sentences). */
  abort(): void {
    this.aborted = true;
    this.buffer = "";
    this.logger.debug("abort", "TTS chunker aborted");
  }

  /** Reset the chunker for a new response. */
  reset(): void {
    this.buffer = "";
    this.sentenceIndex = 0;
    this.aborted = false;
  }

  /**
   * Process a complete text (non-streaming) and dispatch all sentences.
   * Convenience method for when the full text is available at once.
   */
  async processFullText(text: string, onSentence: SentenceCallback): Promise<Result<number, EidolonError>> {
    this.reset();
    let total = 0;

    const sentences = splitSentencesMultilingual(text, this.config.locale);
    for (const sentence of sentences) {
      if (this.aborted) break;
      if (sentence.length >= this.config.minSentenceLength) {
        await onSentence(sentence, this.sentenceIndex++);
        total++;
      }
    }

    return Ok(total);
  }
}

// ---------------------------------------------------------------------------
// Sentence splitting (exported for direct use and testing)
// ---------------------------------------------------------------------------

/**
 * Split text into sentences using Intl.Segmenter with the given locale.
 * Falls back to regex-based splitting if Intl.Segmenter is unavailable.
 *
 * Uses Intl.Segmenter which correctly handles:
 * - Abbreviations (Dr., Mr., etc.) without false splits
 * - German compound sentences and umlauts
 * - Multilingual punctuation (Chinese/Japanese period, etc.)
 * - Ellipsis (...) and other edge cases
 */
export function splitSentencesMultilingual(text: string, locale: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
    return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter((s) => s.length > 0);
  }

  // Fallback: regex-based splitting for environments without Intl.Segmenter
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
