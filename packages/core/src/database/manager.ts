/**
 * DatabaseManager -- manages all 3 SQLite databases (memory, operational, audit).
 *
 * Opens connections, runs migrations, and provides typed accessors.
 * Supports stats retrieval and clean shutdown.
 */

import type { Database } from "bun:sqlite";
import { basename, join } from "node:path";
import type { DatabaseConfig, EidolonError, Result } from "@eidolon/protocol";
import { AUDIT_DB_FILENAME, MEMORY_DB_FILENAME, Ok, OPERATIONAL_DB_FILENAME } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { createConnection } from "./connection.ts";
import { runMigrations } from "./migrations.ts";
import { AUDIT_MIGRATIONS } from "./schemas/audit.ts";
import { MEMORY_MIGRATIONS } from "./schemas/memory.ts";
import { OPERATIONAL_MIGRATIONS } from "./schemas/operational.ts";

export interface DbStats {
  readonly path: string;
  readonly sizeBytes: number;
  readonly tableCount: number;
}

export class DatabaseManager {
  private _memory: Database | null = null;
  private _operational: Database | null = null;
  private _audit: Database | null = null;
  private readonly logger: Logger;
  private readonly config: DatabaseConfig;

  constructor(config: DatabaseConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child("database");
  }

  get memory(): Database {
    if (!this._memory) {
      throw new Error("DatabaseManager not initialized -- call initialize() first");
    }
    return this._memory;
  }

  get operational(): Database {
    if (!this._operational) {
      throw new Error("DatabaseManager not initialized -- call initialize() first");
    }
    return this._operational;
  }

  get audit(): Database {
    if (!this._audit) {
      throw new Error("DatabaseManager not initialized -- call initialize() first");
    }
    return this._audit;
  }

  /** Open all 3 databases and run migrations. */
  initialize(): Result<void, EidolonError> {
    const dir = this.config.directory;

    // Open connections — close already-opened connections on partial failure
    const memResult = createConnection(join(dir, MEMORY_DB_FILENAME), { walMode: this.config.walMode });
    if (!memResult.ok) return memResult;

    const opResult = createConnection(join(dir, OPERATIONAL_DB_FILENAME), { walMode: this.config.walMode });
    if (!opResult.ok) {
      memResult.value.close();
      return opResult;
    }

    const auditResult = createConnection(join(dir, AUDIT_DB_FILENAME), { walMode: this.config.walMode });
    if (!auditResult.ok) {
      memResult.value.close();
      opResult.value.close();
      return auditResult;
    }

    this._memory = memResult.value;
    this._operational = opResult.value;
    this._audit = auditResult.value;

    // Run migrations — close all connections on failure
    const memMig = runMigrations(this._memory, "memory", MEMORY_MIGRATIONS, this.logger);
    if (!memMig.ok) {
      this.close();
      return memMig;
    }

    const opMig = runMigrations(this._operational, "operational", OPERATIONAL_MIGRATIONS, this.logger);
    if (!opMig.ok) {
      this.close();
      return opMig;
    }

    const auditMig = runMigrations(this._audit, "audit", AUDIT_MIGRATIONS, this.logger);
    if (!auditMig.ok) {
      this.close();
      return auditMig;
    }

    this.logger.info("init", "All databases initialized", {
      memoryMigrations: memMig.value,
      operationalMigrations: opMig.value,
      auditMigrations: auditMig.value,
    });

    return Ok(undefined);
  }

  /** Close all database connections. */
  close(): void {
    this._memory?.close();
    this._operational?.close();
    this._audit?.close();
    this._memory = null;
    this._operational = null;
    this._audit = null;
    this.logger.info("close", "All databases closed");
  }

  /** Get stats for all databases. */
  getStats(): { memory: DbStats; operational: DbStats; audit: DbStats } {
    return {
      memory: this.getDbStats(this.memory, join(this.config.directory, MEMORY_DB_FILENAME)),
      operational: this.getDbStats(this.operational, join(this.config.directory, OPERATIONAL_DB_FILENAME)),
      audit: this.getDbStats(this.audit, join(this.config.directory, AUDIT_DB_FILENAME)),
    };
  }

  private getDbStats(db: Database, path: string): DbStats {
    let tableCount = 0;
    try {
      const tables = db
        .query("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT GLOB '_*'")
        .get() as { count: number } | null;
      tableCount = typeof tables?.count === "number" && Number.isFinite(tables.count) ? tables.count : 0;
    } catch {
      // Corrupt sqlite_master or inaccessible database -- report 0 tables
      tableCount = 0;
    }

    const sizeBytes = this.getFileSize(path);

    // Expose only the filename, not the full filesystem path
    return { path: basename(path), sizeBytes, tableCount };
  }

  private getFileSize(path: string): number {
    try {
      const file = Bun.file(path);
      return file.size;
    } catch {
      // File might not exist yet for in-memory DBs
      return 0;
    }
  }
}
