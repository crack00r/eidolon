/**
 * DocumentWatcher -- watches configured directories for file changes and
 * triggers incremental re-indexing via DocumentIndexer.
 *
 * Uses `fs.watch()` with per-file debouncing (1 second) to avoid redundant
 * re-indexes from rapid saves. Handles:
 *   - create/modify -> re-index the file
 *   - delete (rename with no replacement) -> remove indexed chunks
 *
 * Respects the DocumentIndexer's exclude patterns and file type filters.
 */

import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Logger } from "../logging/logger.ts";
import type { DocumentIndexer } from "./document-indexer.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentWatcherOptions {
  /** Debounce interval in milliseconds. Default: 1000. */
  readonly debounceMs?: number;
  /** File extensions to watch (e.g. [".md", ".txt"]). Taken from indexer if omitted. */
  readonly fileTypes?: readonly string[];
  /** Directory/file names to exclude. Taken from indexer if omitted. */
  readonly exclude?: readonly string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 1_000;

// ---------------------------------------------------------------------------
// DocumentWatcher
// ---------------------------------------------------------------------------

export class DocumentWatcher {
  private readonly indexer: DocumentIndexer;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private readonly fileTypes: ReadonlySet<string>;
  private readonly exclude: ReadonlySet<string>;

  private watchers: FSWatcher[] = [];
  private watchedPaths: string[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;

  constructor(indexer: DocumentIndexer, logger: Logger, options?: DocumentWatcherOptions) {
    this.indexer = indexer;
    this.logger = logger.child("document-watcher");
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fileTypes = new Set(options?.fileTypes ?? [".md", ".txt", ".ts", ".py", ".js", ".pdf"]);
    this.exclude = new Set(options?.exclude ?? ["node_modules", ".git", "dist"]);
  }

  /**
   * Start watching the given directory paths for file changes.
   * Each path is watched recursively. Calls are idempotent -- calling
   * startWatching again stops existing watchers first.
   */
  startWatching(paths: readonly string[]): void {
    if (this.running) {
      this.stopWatching();
    }

    this.running = true;
    this.watchedPaths = paths.map((p) => resolve(p));

    for (const dirPath of this.watchedPaths) {
      if (!existsSync(dirPath)) {
        this.logger.warn("startWatching", `Directory does not exist, skipping: ${dirPath}`);
        continue;
      }

      try {
        const watcher = watch(dirPath, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          this.handleFsEvent(dirPath, eventType, filename);
        });

        watcher.on("error", (err: Error) => {
          this.logger.warn("watcher-error", `Watcher error for ${dirPath}: ${err.message}`);
        });

        this.watchers.push(watcher);
        this.logger.info("startWatching", `Watching directory: ${dirPath}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("startWatching", `Failed to watch ${dirPath}: ${message}`);
      }
    }

    this.logger.info("startWatching", `File watching started for ${this.watchers.length} director(ies)`);
  }

  /** Stop all file watchers and clear pending debounce timers. */
  stopWatching(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.watchedPaths = [];
    this.running = false;

    this.logger.info("stopWatching", "File watching stopped");
  }

  /** Whether the watcher is currently active. */
  get isWatching(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private handleFsEvent(baseDir: string, _eventType: string, filename: string): void {
    const fullPath = join(baseDir, filename);

    // Check exclude patterns against each segment of the path
    const segments = filename.split("/");
    for (const segment of segments) {
      if (this.exclude.has(segment)) return;
    }

    // Check file extension (only process known types)
    const ext = extname(filename).toLowerCase();
    if (!this.fileTypes.has(ext)) return;

    // Debounce: reset timer for this specific file path
    const existing = this.debounceTimers.get(fullPath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      fullPath,
      setTimeout(() => {
        this.debounceTimers.delete(fullPath);
        this.processFileChange(fullPath, baseDir).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error("file-changed", `Failed to process file change ${fullPath}: ${message}`, err);
        });
      }, this.debounceMs),
    );
  }

  private async processFileChange(fullPath: string, baseDir: string): Promise<void> {
    if (!this.running) return;

    if (existsSync(fullPath)) {
      // File exists -> create or modify -> re-index
      // First remove old chunks, then re-index
      this.indexer.removeDocument(fullPath);

      const ext = extname(fullPath).toLowerCase();
      const isPdf = ext === ".pdf";
      const result = isPdf
        ? await this.indexer.indexPdfFile(fullPath, baseDir)
        : this.indexer.indexFile(fullPath, baseDir);

      if (result.ok) {
        if (result.value > 0) {
          this.logger.info("file-changed", `Re-indexed ${fullPath} (${result.value} chunks)`);
        }
      } else {
        this.logger.warn("file-changed", `Failed to re-index ${fullPath}: ${result.error.message}`);
      }
    } else {
      // File no longer exists -> delete
      const result = this.indexer.removeDocument(fullPath);
      if (result.ok && result.value > 0) {
        this.logger.info("file-deleted", `Removed ${result.value} chunks for deleted file: ${fullPath}`);
      }
    }
  }
}
