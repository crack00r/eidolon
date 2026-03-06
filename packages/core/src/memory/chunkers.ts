/**
 * Document chunking strategies for the DocumentIndexer.
 *
 * Extracted from document-indexer.ts (P1-29) to keep the indexer focused
 * on file discovery, validation, and storage orchestration.
 *
 * Each chunker splits text content into DocumentChunk objects based on the
 * file type: markdown (by heading), PDF (by page), code (by double-newline),
 * and plain text (by paragraph).
 */

import { extname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentChunk {
  readonly content: string;
  readonly source: string;
  readonly chunkIndex: number;
  readonly heading?: string;
  readonly metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CHUNK_MAX_LENGTH = 2000;

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"]);

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Dispatch to the appropriate chunker based on file extension. */
export function chunkText(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md") return chunkMarkdown(content, filePath, maxLength);
  if (ext === ".pdf") return chunkPdfText(content, filePath, maxLength);
  if (CODE_EXTENSIONS.has(ext)) return chunkCode(content, filePath, maxLength);
  return chunkPlainText(content, filePath, maxLength);
}

// ---------------------------------------------------------------------------
// Markdown chunker
// ---------------------------------------------------------------------------

/** Chunk markdown by headings. Sections exceeding maxLength are split at paragraph boundaries. */
export function chunkMarkdown(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
  const limit = maxLength ?? DEFAULT_CHUNK_MAX_LENGTH;
  const lines = content.split("\n");
  const sections: Array<{ heading?: string; lines: string[] }> = [];
  let current: { heading?: string; lines: string[] } = { lines: [] };

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      // Flush the previous section if it has content
      if (current.lines.length > 0) {
        sections.push(current);
      }
      current = { heading: line.replace(/^#+\s*/, "").trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  // Flush the last section
  if (current.lines.length > 0) {
    sections.push(current);
  }

  const chunks: DocumentChunk[] = [];

  for (const section of sections) {
    const sectionText = section.lines.join("\n").trim();
    if (sectionText.length === 0) continue;

    if (sectionText.length <= limit) {
      chunks.push({
        content: sectionText,
        source: filePath,
        chunkIndex: chunks.length,
        heading: section.heading,
        metadata: {},
      });
    } else {
      // Split oversized sections at paragraph boundaries
      const paragraphs = sectionText.split(/\n\n+/);
      let buffer = "";

      for (const para of paragraphs) {
        const candidate = buffer.length === 0 ? para : `${buffer}\n\n${para}`;
        if (candidate.length > limit && buffer.length > 0) {
          chunks.push({
            content: buffer.trim(),
            source: filePath,
            chunkIndex: chunks.length,
            heading: section.heading,
            metadata: {},
          });
          buffer = para;
        } else {
          buffer = candidate;
        }
      }
      if (buffer.trim().length > 0) {
        chunks.push({
          content: buffer.trim(),
          source: filePath,
          chunkIndex: chunks.length,
          heading: section.heading,
          metadata: {},
        });
      }
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// PDF chunker
// ---------------------------------------------------------------------------

/**
 * Chunk already-extracted PDF text by page separators (form-feed characters).
 * Each page becomes a separate chunk. Pages exceeding maxLength are split
 * at paragraph boundaries.
 */
export function chunkPdfText(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
  const limit = maxLength ?? DEFAULT_CHUNK_MAX_LENGTH;
  // pdf-parse separates pages with form-feed characters (\f)
  const pages = content.split("\f");
  const chunks: DocumentChunk[] = [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageText = (pages[pageIdx] ?? "").trim();
    if (pageText.length === 0) continue;

    if (pageText.length <= limit) {
      chunks.push({
        content: pageText,
        source: filePath,
        chunkIndex: chunks.length,
        heading: `Page ${pageIdx + 1}`,
        metadata: { page: pageIdx + 1 },
      });
    } else {
      // Split oversized pages at paragraph boundaries
      const paragraphs = pageText.split(/\n\n+/);
      let buffer = "";

      for (const para of paragraphs) {
        const candidate = buffer.length === 0 ? para : `${buffer}\n\n${para}`;
        if (candidate.length > limit && buffer.length > 0) {
          chunks.push({
            content: buffer.trim(),
            source: filePath,
            chunkIndex: chunks.length,
            heading: `Page ${pageIdx + 1}`,
            metadata: { page: pageIdx + 1 },
          });
          buffer = para;
        } else {
          buffer = candidate;
        }
      }
      if (buffer.trim().length > 0) {
        chunks.push({
          content: buffer.trim(),
          source: filePath,
          chunkIndex: chunks.length,
          heading: `Page ${pageIdx + 1}`,
          metadata: { page: pageIdx + 1 },
        });
      }
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Code chunker
// ---------------------------------------------------------------------------

/** Chunk code files by double-newline-separated blocks, merging small blocks. */
export function chunkCode(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
  const limit = maxLength ?? DEFAULT_CHUNK_MAX_LENGTH;
  const blocks = content.split(/\n\n+/);
  return mergeBlocks(blocks, filePath, limit);
}

// ---------------------------------------------------------------------------
// Plain text chunker
// ---------------------------------------------------------------------------

/** Chunk plain text by paragraphs, merging small paragraphs. */
export function chunkPlainText(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
  const limit = maxLength ?? DEFAULT_CHUNK_MAX_LENGTH;
  const paragraphs = content.split(/\n\n+/);
  return mergeBlocks(paragraphs, filePath, limit);
}

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

/** Merge small blocks into chunks that don't exceed maxLength. */
function mergeBlocks(blocks: string[], filePath: string, maxLength: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let buffer = "";

  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;

    const candidate = buffer.length === 0 ? trimmed : `${buffer}\n\n${trimmed}`;
    if (candidate.length > maxLength && buffer.length > 0) {
      chunks.push({
        content: buffer,
        source: filePath,
        chunkIndex: chunks.length,
        metadata: {},
      });
      buffer = trimmed;
    } else {
      buffer = candidate;
    }
  }

  if (buffer.trim().length > 0) {
    chunks.push({
      content: buffer.trim(),
      source: filePath,
      chunkIndex: chunks.length,
      metadata: {},
    });
  }

  return chunks;
}
