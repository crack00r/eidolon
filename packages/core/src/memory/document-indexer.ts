/**
 * DocumentIndexer -- indexes personal documents (markdown, text, PDF, code) into the
 * memory system so they participate in the same search as conversation memories.
 *
 * Supported file types:
 *   - Markdown (.md)     -> chunked by heading
 *   - Plain text (.txt)  -> chunked by paragraph
 *   - PDF (.pdf)         -> chunked by page
 *   - Code (.ts, .tsx, .js, .jsx, .py, .rs, .go) -> chunked by double-newline blocks
 */

import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { chunkCode, chunkMarkdown, chunkPdfText, chunkPlainText, chunkText } from "./chunkers.ts";
import type { MemoryStore } from "./store.ts";

// Re-export DocumentChunk for backward compatibility
export type { DocumentChunk } from "./chunkers.ts";

// pdf-parse is an optional dependency; we dynamically import to avoid hard failures
// when it is not installed.
type PdfParseResult = { numpages: number; text: string; info?: Record<string, unknown> };
type PdfParseFn = (dataBuffer: Buffer) => Promise<PdfParseResult>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexingOptions {
  readonly fileTypes?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxFileSize?: number;
  readonly chunkMaxLength?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_FILE_TYPES: readonly string[] = [".md", ".txt", ".pdf", ".ts", ".py", ".js"];
const DEFAULT_EXCLUDE: readonly string[] = ["node_modules", ".git", "dist"];
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB

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
  private readonly chunkMaxLength: number | undefined;

  constructor(db: Database, store: MemoryStore, logger: Logger, options?: IndexingOptions) {
    this.db = db;
    this.store = store;
    this.logger = logger.child("document-indexer");
    this.fileTypes = options?.fileTypes ?? DEFAULT_FILE_TYPES;
    this.exclude = options?.exclude ?? DEFAULT_EXCLUDE;
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.chunkMaxLength = options?.chunkMaxLength;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Index a single file. Returns the number of chunks stored.
   * For PDF files, use `indexPdfFile()` instead (requires async).
   */
  indexFile(filePath: string, baseDir?: string): Result<number, EidolonError> {
    try {
      const absPath = resolve(filePath);

      // PDF files need async parsing -- redirect callers to indexPdfFile()
      if (extname(absPath).toLowerCase() === ".pdf") {
        return Err(
          createError(
            ErrorCode.DB_QUERY_FAILED,
            `PDF files require async indexing. Use indexPdfFile() instead for: ${absPath}`,
          ),
        );
      }

      if (!existsSync(absPath)) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `File not found: ${absPath}`));
      }

      // Security: skip symlinks to prevent indexing files outside intended directory
      const lstat = lstatSync(absPath);
      if (lstat.isSymbolicLink()) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Refusing to index symlink: ${absPath}`));
      }

      // If a base directory constraint is provided, verify the real path is within it.
      // Check startsWith(realBase + "/") to prevent prefix confusion
      // (e.g., /home/user/docs-evil matching /home/user/docs).
      if (baseDir) {
        const realPath = realpathSync(absPath);
        const realBase = realpathSync(baseDir);
        if (realPath !== realBase && !realPath.startsWith(realBase + "/")) {
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

  /** Index all files in a directory (recursive). Handles PDFs asynchronously. */
  async indexDirectory(dirPath: string): Promise<Result<{ files: number; chunks: number }, EidolonError>> {
    try {
      const absDir = resolve(dirPath);

      if (!existsSync(absDir)) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Directory not found: ${absDir}`));
      }

      const files = this.walkDirectory(absDir);
      let totalFiles = 0;
      let totalChunks = 0;

      for (const file of files) {
        const isPdf = extname(file).toLowerCase() === ".pdf";
        const result = isPdf ? await this.indexPdfFile(file, absDir) : this.indexFile(file, absDir);
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
  // Static chunking methods (delegate to chunkers module)
  // -------------------------------------------------------------------------

  /** Dispatch to the appropriate chunker based on file extension. */
  static chunkText = chunkText;

  /** Chunk markdown by headings. */
  static chunkMarkdown = chunkMarkdown;

  /** Chunk already-extracted PDF text by page separators. */
  static chunkPdfText = chunkPdfText;

  /** Chunk code files by double-newline-separated blocks. */
  static chunkCode = chunkCode;

  /** Chunk plain text by paragraphs. */
  static chunkPlainText = chunkPlainText;

  /**
   * Extract text from a PDF file using pdf-parse.
   * Returns Ok(text) or Err if pdf-parse is not available or parsing fails.
   */
  static async extractPdfText(filePath: string): Promise<Result<string, EidolonError>> {
    try {
      // Dynamic import so the module is optional at runtime.
      // Use a variable to prevent TypeScript from resolving the module statically.
      const moduleName = "pdf-parse";
      const pdfParseModule = await import(/* @vite-ignore */ moduleName);
      let pdfParse: PdfParseFn;
      if (typeof pdfParseModule.default === "function") {
        pdfParse = pdfParseModule.default as PdfParseFn;
      } else if (typeof pdfParseModule === "function") {
        pdfParse = pdfParseModule as unknown as PdfParseFn;
      } else {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "pdf-parse module does not export a callable function"));
      }

      const dataBuffer = readFileSync(filePath);
      const parsed = await pdfParse(Buffer.from(dataBuffer));
      return Ok(parsed.text);
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message.includes("Cannot find")
          ? "pdf-parse is not installed. Run: pnpm add pdf-parse"
          : `Failed to parse PDF: ${filePath}`;
      return Err(createError(ErrorCode.DB_QUERY_FAILED, message, cause));
    }
  }

  /**
   * Index a PDF file asynchronously.
   * Extracts text via pdf-parse, chunks by page, and stores as memories.
   */
  async indexPdfFile(filePath: string, baseDir?: string): Promise<Result<number, EidolonError>> {
    const absPath = resolve(filePath);

    if (!existsSync(absPath)) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `File not found: ${absPath}`));
    }

    const lstat = lstatSync(absPath);
    if (lstat.isSymbolicLink()) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Refusing to index symlink: ${absPath}`));
    }

    if (baseDir) {
      const realPath = realpathSync(absPath);
      const realBase = realpathSync(baseDir);
      if (realPath !== realBase && !realPath.startsWith(realBase + "/")) {
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

    const textResult = await DocumentIndexer.extractPdfText(absPath);
    if (!textResult.ok) return textResult;

    const chunks = DocumentIndexer.chunkPdfText(textResult.value, absPath, this.chunkMaxLength);

    if (chunks.length === 0) {
      this.logger.debug("indexPdfFile", `No chunks produced for ${absPath}`);
      return Ok(0);
    }

    const sourceTag = `document:${absPath}`;

    const inputs = chunks.map((chunk) => ({
      type: "fact" as const,
      layer: "long_term" as const,
      content: chunk.content,
      confidence: 1.0,
      source: sourceTag,
      tags: ["document", "pdf"],
      metadata: {
        filePath: absPath,
        chunkIndex: chunk.chunkIndex,
        heading: chunk.heading,
        page: chunk.metadata.page,
        indexedAt: Date.now(),
      },
    }));

    const result = this.store.createBatch(inputs);
    if (!result.ok) return result;

    this.logger.info("indexPdfFile", `Indexed ${chunks.length} chunks from ${absPath}`);
    return Ok(chunks.length);
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
