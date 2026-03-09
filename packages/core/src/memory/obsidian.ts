/**
 * ObsidianIndexer -- indexes Obsidian vault markdown files into the memory
 * system, parsing [[wikilinks]] and #tags to create KG edges between notes.
 *
 * Each note becomes a memory; wikilinks and tags are stored as KG entities
 * and relations so the knowledge graph reflects the vault's link structure.
 */

import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { KGEntityStore } from "./knowledge-graph/entities.ts";
import type { KGRelationStore } from "./knowledge-graph/relations.ts";
import type { MemoryStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObsidianIndexerOptions {
  /** Directories or file names to exclude (default: [".obsidian", ".trash"]). */
  readonly exclude?: readonly string[];
  /** Maximum file size in bytes (default: 1 MB). */
  readonly maxFileSize?: number;
}

export interface ObsidianIndexResult {
  readonly filesIndexed: number;
  readonly chunksStored: number;
  readonly entitiesCreated: number;
  readonly relationsCreated: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXCLUDE: readonly string[] = [".obsidian", ".trash"];
const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1 MB
const MAX_DIRECTORY_DEPTH = 20;

// ---------------------------------------------------------------------------
// Parsing helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Extract all [[wikilinks]] from markdown content, returning unique targets. */
export function parseWikilinks(content: string): string[] {
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]*)?\|?[^\]]*\]\]/g;
  const targets = new Set<string>();
  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    const target = (match[1] ?? "").trim();
    if (target.length > 0) {
      targets.add(target);
    }
    match = regex.exec(content);
  }
  return [...targets];
}

/** Extract all #tags from markdown content, returning unique normalized tags. */
export function parseObsidianTags(content: string): string[] {
  // Match #tag but not inside code blocks or URLs.
  // Simple approach: match #word sequences not preceded by & (HTML entities)
  const regex = /(?:^|\s)#([\w][\w/-]*)/g;
  const tags = new Set<string>();
  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    const tag = (match[1] ?? "").trim().toLowerCase();
    if (tag.length > 0) {
      tags.add(tag);
    }
    match = regex.exec(content);
  }
  return [...tags];
}

// ---------------------------------------------------------------------------
// ObsidianIndexer
// ---------------------------------------------------------------------------

export class ObsidianIndexer {
  private readonly db: Database;
  private readonly store: MemoryStore;
  private readonly entityStore: KGEntityStore;
  private readonly relationStore: KGRelationStore;
  private readonly logger: Logger;
  private readonly exclude: readonly string[];
  private readonly maxFileSize: number;

  constructor(
    db: Database,
    store: MemoryStore,
    entityStore: KGEntityStore,
    relationStore: KGRelationStore,
    logger: Logger,
    options?: ObsidianIndexerOptions,
  ) {
    this.db = db;
    this.store = store;
    this.entityStore = entityStore;
    this.relationStore = relationStore;
    this.logger = logger.child("obsidian-indexer");
    this.exclude = options?.exclude ?? DEFAULT_EXCLUDE;
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  }

  /** Index an entire Obsidian vault directory. */
  indexVault(vaultPath: string): Result<ObsidianIndexResult, EidolonError> {
    try {
      const absVault = resolve(vaultPath);
      if (!existsSync(absVault)) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Vault not found: ${absVault}`));
      }

      const files = this.walkMarkdownFiles(absVault, 0);
      let filesIndexed = 0;
      let chunksStored = 0;
      let entitiesCreated = 0;
      let relationsCreated = 0;

      for (const filePath of files) {
        const result = this.indexNote(filePath, absVault);
        if (!result.ok) {
          this.logger.warn("indexVault", `Skipping ${filePath}: ${result.error.message}`);
          continue;
        }
        filesIndexed++;
        chunksStored += result.value.chunksStored;
        entitiesCreated += result.value.entitiesCreated;
        relationsCreated += result.value.relationsCreated;
      }

      this.logger.info("indexVault", `Indexed ${filesIndexed} notes from ${absVault}`, {
        chunksStored,
        entitiesCreated,
        relationsCreated,
      });

      return Ok({ filesIndexed, chunksStored, entitiesCreated, relationsCreated });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to index vault: ${vaultPath}`, cause));
    }
  }

  /** Index a single Obsidian note. */
  indexNote(
    filePath: string,
    vaultRoot: string,
  ): Result<{ chunksStored: number; entitiesCreated: number; relationsCreated: number }, EidolonError> {
    try {
      const resolvedPath = resolve(filePath);
      const resolvedVaultRoot = resolve(vaultRoot);

      // Use realpathSync to resolve symlinks and macOS /private prefix,
      // falling back to resolve() if the path doesn't exist yet.
      let absPath: string;
      let absVaultRoot: string;
      try {
        absPath = realpathSync(resolvedPath);
      } catch {
        absPath = resolvedPath;
      }
      try {
        absVaultRoot = realpathSync(resolvedVaultRoot);
      } catch {
        absVaultRoot = resolvedVaultRoot;
      }

      // Path containment check: ensure file is within the vault root
      if (!absPath.startsWith(absVaultRoot + "/") && absPath !== absVaultRoot) {
        return Err(
          createError(ErrorCode.DB_QUERY_FAILED, `File path ${absPath} is outside vault root ${absVaultRoot}`),
        );
      }

      if (!existsSync(absPath)) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `File not found: ${absPath}`));
      }

      const stat = statSync(absPath);
      if (stat.size > this.maxFileSize) {
        return Err(
          createError(ErrorCode.DB_QUERY_FAILED, `File exceeds max size (${stat.size} > ${this.maxFileSize})`),
        );
      }

      const content = readFileSync(absPath, "utf-8");
      const noteName = noteNameFromPath(absPath);
      const relPath = relative(resolve(vaultRoot), absPath);
      const sourceTag = `obsidian:${relPath}`;

      const tags = parseObsidianTags(content);
      const inputs = [
        {
          type: "fact" as const,
          layer: "long_term" as const,
          content,
          confidence: 1.0,
          source: sourceTag,
          tags: ["obsidian", ...tags],
          metadata: { filePath: absPath, noteName, vaultRelPath: relPath },
        },
      ];

      // Wrap DELETE + createBatch in a transaction for atomicity
      const batchResult = this.store.withTransaction(() => {
        this.db.query("DELETE FROM memories WHERE source = ?").run(sourceTag);
        return this.store.createBatch(inputs);
      });
      if (!batchResult.ok) return batchResult;

      // Create KG entity for this note
      let entitiesCreated = 0;
      let relationsCreated = 0;

      const noteEntityResult = this.entityStore.findOrCreate({
        name: noteName,
        type: "concept",
        attributes: { obsidianPath: relPath },
      });
      if (noteEntityResult.ok && noteEntityResult.value.created) {
        entitiesCreated++;
      }

      // Parse wikilinks and create entities + relations
      const wikilinks = parseWikilinks(content);
      for (const linkTarget of wikilinks) {
        const targetEntityResult = this.entityStore.findOrCreate({
          name: linkTarget,
          type: "concept",
          attributes: {},
        });
        if (!targetEntityResult.ok) continue;
        if (targetEntityResult.value.created) {
          entitiesCreated++;
        }

        if (noteEntityResult.ok) {
          const relResult = this.relationStore.create({
            sourceId: noteEntityResult.value.entity.id,
            targetId: targetEntityResult.value.entity.id,
            type: "related_to",
            confidence: 1.0,
            source: sourceTag,
          });
          if (relResult.ok) {
            relationsCreated++;
          }
        }
      }

      return Ok({ chunksStored: batchResult.value.length, entitiesCreated, relationsCreated });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to index note: ${filePath}`, cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Recursively walk a vault directory, returning .md file paths. */
  private walkMarkdownFiles(dirPath: string, depth: number): string[] {
    if (depth >= MAX_DIRECTORY_DEPTH) {
      return [];
    }

    const results: string[] = [];
    const dirLstat = lstatSync(dirPath);
    if (dirLstat.isSymbolicLink()) return results;

    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (this.exclude.includes(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkMarkdownFiles(fullPath, depth + 1));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Extract a note name from a file path (filename without extension). */
function noteNameFromPath(filePath: string): string {
  return basename(filePath, ".md");
}
