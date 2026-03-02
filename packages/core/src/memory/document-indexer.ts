/**
 * DocumentIndexer -- indexes personal documents (markdown, text, code) into the
 * memory system so they participate in the same search as conversation memories.
 *
 * Supported file types:
 *   - Markdown (.md)     → chunked by heading
 *   - Plain text (.txt)  → chunked by paragraph
 *   - Code (.ts, .tsx, .js, .jsx, .py, .rs, .go) → chunked by double-newline blocks
 */

import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { MemoryStore } from "./store.ts";

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

export interface IndexingOptions {
  readonly fileTypes?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFileSize?: number;
  readonly chunkMaxLength?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_FILE_TYPES: readonly string[] = [".md", ".txt", ".ts", ".py", ".js"];
const DEFAULT_EXCLUDE: readonly string[] = ["node_modules", ".git", "dist"];
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB
const DEFAULT_CHUNK_MAX_LENGTH = 2000;

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"]);

/** Maximum directory recursion depth to prevent excessive traversal or symlink loops. */
const MAX_DIRECTORY_DEPTH = 20;

// ---------------------------------------------------------------------------
// DocumentIndexer
// ---------------------------------------------------------------------------

export class DocumentIndexer {
  private readonly db: Database;
  private readonly store: MemoryStore;
  private readonly logger: Logger;
  private readonly fileTypes: readonly string[];
  private readonly exclude: readonly string[];
  private readonly maxFileSize: number;
  private readonly chunkMaxLength: number;

  constructor(db: Database, store: MemoryStore, logger: Logger, options?: IndexingOptions) {
    this.db = db;
    this.store = store;
    this.logger = logger.child("document-indexer");
    this.fileTypes = options?.fileTypes ?? DEFAULT_FILE_TYPES;
    this.exclude = options?.exclude ?? DEFAULT_EXCLUDE;
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.chunkMaxLength = options?.chunkMaxLength ?? DEFAULT_CHUNK_MAX_LENGTH;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Index a single file. Returns the number of chunks stored. */
  indexFile(filePath: string, baseDir?: string): Result<number, EidolonError> {
    try {
      const absPath = resolve(filePath);

      if (!existsSync(absPath)) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `File not found: ${absPath}`));
      }

      // Security: skip symlinks to prevent indexing files outside intended directory
      const lstat = lstatSync(absPath);
      if (lstat.isSymbolicLink()) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Refusing to index symlink: ${absPath}`));
      }

      // If a base directory constraint is provided, verify the real path is within it
      if (baseDir) {
        const realPath = realpathSync(absPath);
        const realBase = realpathSync(baseDir);
        if (!realPath.startsWith(realBase)) {
          return Err(createError(ErrorCode.DB_QUERY_FAILED, `File is outside base directory: ${absPath}`));
        }
      }

      const stat = statSync(absPath);
      if (stat.size > this.maxFileSize) {
        return Err(
          createError(
            ErrorCode.DB_QUERY_FAILED,
            `File exceeds max size (${stat.size} > ${this.maxFileSize}): ${absPath}`,
          ),
        );
      }

      const content = readFileSync(absPath, "utf-8");
      const chunks = DocumentIndexer.chunkText(content, absPath, this.chunkMaxLength);

      if (chunks.length === 0) {
        this.logger.debug("indexFile", `No chunks produced for ${absPath}`);
        return Ok(0);
      }

      const ext = extname(absPath).toLowerCase();
      const sourceTag = `document:${absPath}`;

      const inputs = chunks.map((chunk) => ({
        type: "fact" as const,
        layer: "long_term" as const,
        content: chunk.content,
        confidence: 1.0,
        source: sourceTag,
        tags: ["document", ext.slice(1)],
        metadata: {
          filePath: absPath,
          chunkIndex: chunk.chunkIndex,
          heading: chunk.heading,
          indexedAt: Date.now(),
        },
      }));

      const result = this.store.createBatch(inputs);
      if (!result.ok) return result;

      this.logger.info("indexFile", `Indexed ${chunks.length} chunks from ${absPath}`);
      return Ok(chunks.length);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to index file: ${filePath}`, cause));
    }
  }

  /** Index all files in a directory (recursive). */
  indexDirectory(dirPath: string): Result<{ files: number; chunks: number }, EidolonError> {
    try {
      const absDir = resolve(dirPath);

      if (!existsSync(absDir)) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Directory not found: ${absDir}`));
      }

      const files = this.walkDirectory(absDir);
      let totalFiles = 0;
      let totalChunks = 0;

      for (const file of files) {
        const result = this.indexFile(file, absDir);
        if (!result.ok) {
          this.logger.warn("indexDirectory", `Skipping file ${file}: ${result.error.message}`);
          continue;
        }
        totalFiles++;
        totalChunks += result.value;
      }

      this.logger.info("indexDirectory", `Indexed ${totalFiles} files (${totalChunks} chunks) from ${absDir}`);
      return Ok({ files: totalFiles, chunks: totalChunks });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to index directory: ${dirPath}`, cause));
    }
  }

  /** Remove all memories from a specific document source. */
  removeDocument(filePath: string): Result<number, EidolonError> {
    try {
      const absPath = resolve(filePath);
      const sourceTag = `document:${absPath}`;

      const countRow = this.db.query("SELECT COUNT(*) as count FROM memories WHERE source = ?").get(sourceTag) as {
        count: number;
      } | null;

      const count = countRow?.count ?? 0;

      if (count > 0) {
        this.db.query("DELETE FROM memories WHERE source = ?").run(sourceTag);
      }

      this.logger.debug("removeDocument", `Removed ${count} chunks for ${absPath}`);
      return Ok(count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to remove document: ${filePath}`, cause));
    }
  }

  /** Check if a file has been indexed (by source path). */
  isIndexed(filePath: string): Result<boolean, EidolonError> {
    try {
      const absPath = resolve(filePath);
      const sourceTag = `document:${absPath}`;

      const row = this.db.query("SELECT COUNT(*) as count FROM memories WHERE source = ?").get(sourceTag) as {
        count: number;
      } | null;

      return Ok((row?.count ?? 0) > 0);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to check indexing status: ${filePath}`, cause));
    }
  }

  // -------------------------------------------------------------------------
  // Static chunking methods
  // -------------------------------------------------------------------------

  /** Dispatch to the appropriate chunker based on file extension. */
  static chunkText(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".md") return DocumentIndexer.chunkMarkdown(content, filePath, maxLength);
    if (CODE_EXTENSIONS.has(ext)) return DocumentIndexer.chunkCode(content, filePath, maxLength);
    return DocumentIndexer.chunkPlainText(content, filePath, maxLength);
  }

  /** Chunk markdown by headings. Sections exceeding maxLength are split at paragraph boundaries. */
  static chunkMarkdown(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
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

  /** Chunk code files by double-newline-separated blocks, merging small blocks. */
  static chunkCode(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
    const limit = maxLength ?? DEFAULT_CHUNK_MAX_LENGTH;
    const blocks = content.split(/\n\n+/);
    return mergeBlocks(blocks, filePath, limit);
  }

  /** Chunk plain text by paragraphs, merging small paragraphs. */
  static chunkPlainText(content: string, filePath: string, maxLength?: number): DocumentChunk[] {
    const limit = maxLength ?? DEFAULT_CHUNK_MAX_LENGTH;
    const paragraphs = content.split(/\n\n+/);
    return mergeBlocks(paragraphs, filePath, limit);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Recursively walk a directory, returning file paths matching filters.
   *  Skips symlinks to prevent traversal outside the intended directory.
   *  Depth is bounded by MAX_DIRECTORY_DEPTH to prevent excessive recursion. */
  private walkDirectory(dirPath: string, depth = 0): string[] {
    if (depth >= MAX_DIRECTORY_DEPTH) {
      this.logger.warn("walkDirectory", `Max directory depth (${MAX_DIRECTORY_DEPTH}) reached, skipping: ${dirPath}`);
      return [];
    }

    const results: string[] = [];

    // Skip if the directory itself is a symlink
    const dirLstat = lstatSync(dirPath);
    if (dirLstat.isSymbolicLink()) {
      this.logger.debug("walkDirectory", `Skipping symlinked directory: ${dirPath}`);
      return results;
    }

    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (this.exclude.includes(entry.name)) continue;

      const fullPath = join(dirPath, entry.name);

      // Skip symlinks entirely
      if (entry.isSymbolicLink()) {
        this.logger.debug("walkDirectory", `Skipping symlink: ${fullPath}`);
        continue;
      }

      if (entry.isDirectory()) {
        results.push(...this.walkDirectory(fullPath, depth + 1));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (this.fileTypes.includes(ext)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }
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
