/**
 * DiscoveryEngine -- CRUD operations for self-learning discoveries.
 *
 * Stores and retrieves discovered content (articles, posts, repos) from
 * the operational database's `discoveries` table. Provides budget enforcement
 * (daily count) and deduplication (URL uniqueness).
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";
import type { SafetyLevel } from "./safety.js";

export type SourceType = "reddit" | "hackernews" | "github" | "rss" | "arxiv";

export type DiscoveryStatus = "new" | "evaluated" | "approved" | "rejected" | "implemented";

export interface Discovery {
  readonly id: string;
  readonly sourceType: SourceType;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly relevanceScore: number;
  readonly safetyLevel: SafetyLevel;
  readonly status: DiscoveryStatus;
  readonly implementationBranch?: string;
  readonly createdAt: number;
  readonly evaluatedAt?: number;
  readonly implementedAt?: number;
}

export interface CreateDiscoveryInput {
  readonly sourceType: SourceType;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly relevanceScore: number;
  readonly safetyLevel: SafetyLevel;
}

interface DiscoveryRow {
  id: string;
  source_type: string;
  url: string;
  title: string;
  content: string;
  relevance_score: number;
  safety_level: string;
  status: string;
  implementation_branch: string | null;
  created_at: number;
  evaluated_at: number | null;
  implemented_at: number | null;
}

function validateEnum<T extends string>(value: unknown, valid: Set<string>, fallback: T): T {
  return valid.has(String(value)) ? (String(value) as T) : fallback;
}

const VALID_SOURCE_TYPES = new Set<string>(["reddit", "hackernews", "github", "rss", "arxiv"]);
const VALID_DISCOVERY_STATUSES = new Set<string>(["new", "evaluated", "approved", "rejected", "implemented"]);
const VALID_SAFETY_LEVELS = new Set<string>(["safe", "needs_approval", "dangerous"]);

/** Maximum allowed content length for a discovery (1 MB). */
const MAX_DISCOVERY_CONTENT_LENGTH = 1_048_576;

/** Maximum allowed URL length. */
const MAX_URL_LENGTH = 8192;

/** Maximum allowed title length. */
const MAX_TITLE_LENGTH = 1000;

/** Default list limit for discovery queries. */
const DEFAULT_LIST_LIMIT = 50;

/** Maximum list limit for discovery queries. */
const MAX_LIST_LIMIT = 1000;

function rowToDiscovery(row: DiscoveryRow): Discovery {
  return {
    id: row.id,
    sourceType: validateEnum<SourceType>(row.source_type, VALID_SOURCE_TYPES, "reddit"),
    url: row.url,
    title: row.title,
    content: row.content,
    relevanceScore: row.relevance_score,
    safetyLevel: validateEnum<SafetyLevel>(row.safety_level, VALID_SAFETY_LEVELS, "dangerous"),
    status: validateEnum<DiscoveryStatus>(row.status, VALID_DISCOVERY_STATUSES, "new"),
    implementationBranch: row.implementation_branch ?? undefined,
    createdAt: row.created_at,
    evaluatedAt: row.evaluated_at ?? undefined,
    implementedAt: row.implemented_at ?? undefined,
  };
}

export class DiscoveryEngine {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("discovery");
  }

  /** Store a new discovery. */
  create(input: CreateDiscoveryInput): Result<Discovery, EidolonError> {
    if (!Number.isFinite(input.relevanceScore) || input.relevanceScore < 0 || input.relevanceScore > 1) {
      return Err(
        createError(
          ErrorCode.DISCOVERY_FAILED,
          `Relevance score must be a finite number in [0, 1], got ${input.relevanceScore}`,
        ),
      );
    }
    if (input.url.length > MAX_URL_LENGTH) {
      return Err(
        createError(ErrorCode.DISCOVERY_FAILED, `URL exceeds maximum length (${input.url.length} > ${MAX_URL_LENGTH})`),
      );
    }
    if (input.title.length > MAX_TITLE_LENGTH) {
      return Err(
        createError(
          ErrorCode.DISCOVERY_FAILED,
          `Title exceeds maximum length (${input.title.length} > ${MAX_TITLE_LENGTH})`,
        ),
      );
    }
    if (input.content.length > MAX_DISCOVERY_CONTENT_LENGTH) {
      return Err(
        createError(
          ErrorCode.DISCOVERY_FAILED,
          `Content exceeds maximum length (${input.content.length} > ${MAX_DISCOVERY_CONTENT_LENGTH})`,
        ),
      );
    }
    try {
      const id = crypto.randomUUID();
      const now = Date.now();

      this.db
        .query(
          `INSERT INTO discoveries
           (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
        )
        .run(id, input.sourceType, input.url, input.title, input.content, input.relevanceScore, input.safetyLevel, now);

      const discovery: Discovery = {
        id,
        sourceType: input.sourceType,
        url: input.url,
        title: input.title,
        content: input.content,
        relevanceScore: input.relevanceScore,
        safetyLevel: input.safetyLevel,
        status: "new",
        createdAt: now,
      };

      this.logger.info("create", `Stored discovery: ${input.title}`, {
        id,
        sourceType: input.sourceType,
        url: input.url,
      });

      return Ok(discovery);
    } catch (cause) {
      return Err(createError(ErrorCode.DISCOVERY_FAILED, `Failed to create discovery: ${input.url}`, cause));
    }
  }

  /** Get a discovery by ID. */
  get(id: string): Result<Discovery | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM discoveries WHERE id = ?").get(id) as DiscoveryRow | null;
      return Ok(row ? rowToDiscovery(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get discovery: ${id}`, cause));
    }
  }

  /** List discoveries by status. */
  listByStatus(status: DiscoveryStatus, limit = DEFAULT_LIST_LIMIT): Result<Discovery[], EidolonError> {
    const safeLimit = Math.max(1, Math.min(limit, MAX_LIST_LIMIT));
    try {
      const rows = this.db
        .query("SELECT * FROM discoveries WHERE status = ? ORDER BY created_at DESC LIMIT ?")
        .all(status, safeLimit) as DiscoveryRow[];
      return Ok(rows.map(rowToDiscovery));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to list discoveries by status: ${status}`, cause));
    }
  }

  /** Update discovery status. */
  updateStatus(id: string, status: DiscoveryStatus): Result<void, EidolonError> {
    try {
      const now = Date.now();

      if (status === "evaluated") {
        this.db.query("UPDATE discoveries SET status = ?, evaluated_at = ? WHERE id = ?").run(status, now, id);
      } else if (status === "implemented") {
        this.db.query("UPDATE discoveries SET status = ?, implemented_at = ? WHERE id = ?").run(status, now, id);
      } else {
        this.db.query("UPDATE discoveries SET status = ? WHERE id = ?").run(status, id);
      }

      this.logger.debug("updateStatus", `Discovery ${id} -> ${status}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update discovery status: ${id}`, cause));
    }
  }

  /** Set implementation branch. */
  setImplementationBranch(id: string, branch: string): Result<void, EidolonError> {
    try {
      this.db.query("UPDATE discoveries SET implementation_branch = ? WHERE id = ?").run(branch, id);
      this.logger.debug("setImplementationBranch", `Discovery ${id} -> branch ${branch}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to set implementation branch: ${id}`, cause));
    }
  }

  /** Check if a URL has already been discovered. */
  isKnown(url: string): Result<boolean, EidolonError> {
    try {
      const row = this.db.query("SELECT 1 FROM discoveries WHERE url = ? LIMIT 1").get(url) as Record<
        string,
        unknown
      > | null;
      return Ok(row !== null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to check known URL: ${url}`, cause));
    }
  }

  /** Count discoveries created today (for budget enforcement). */
  countToday(): Result<number, EidolonError> {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const row = this.db
        .query("SELECT COUNT(*) as count FROM discoveries WHERE created_at >= ?")
        .get(startOfDay.getTime()) as { count: number };
      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count today's discoveries", cause));
    }
  }

  /** Get discovery statistics. */
  getStats(): Result<{ total: number; byStatus: Record<string, number> }, EidolonError> {
    try {
      const totalRow = this.db.query("SELECT COUNT(*) as count FROM discoveries").get() as {
        count: number;
      };
      const statusRows = this.db
        .query("SELECT status, COUNT(*) as count FROM discoveries GROUP BY status")
        .all() as Array<{ status: string; count: number }>;

      const byStatus: Record<string, number> = {};
      for (const row of statusRows) {
        byStatus[row.status] = row.count;
      }

      return Ok({ total: totalRow.count, byStatus });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get discovery stats", cause));
    }
  }

  /** Delete a discovery. */
  delete(id: string): Result<void, EidolonError> {
    try {
      this.db.query("DELETE FROM discoveries WHERE id = ?").run(id);
      this.logger.debug("delete", `Deleted discovery ${id}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete discovery: ${id}`, cause));
    }
  }
}
