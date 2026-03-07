/**
 * UserManager -- CRUD operations for multi-user management.
 *
 * Stores users in the operational.db `users` table.
 * Provides lookup by ID, by channel mapping, and list/delete operations.
 * Uses the "default" user for backward-compatible single-user mode.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { CreateUserInput, UpdateUserInput, User, UserRow } from "./schema.ts";
import { DEFAULT_USER_ID, rowToUser } from "./schema.ts";

// ---------------------------------------------------------------------------
// UserManager
// ---------------------------------------------------------------------------

export class UserManager {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("user-manager");
  }

  /**
   * Ensure the default user exists. Called during initialization
   * to guarantee backward compatibility.
   */
  ensureDefaultUser(): Result<User, EidolonError> {
    const existing = this.get(DEFAULT_USER_ID);
    if (!existing.ok) return existing;
    if (existing.value !== null) return Ok(existing.value);

    return this.create({
      id: DEFAULT_USER_ID,
      name: "Default User",
      channelMappings: [],
      preferences: {},
    });
  }

  /** Create a new user. Generates a UUID if no ID is provided. */
  create(input: CreateUserInput): Result<User, EidolonError> {
    try {
      const id = input.id ?? randomUUID();
      const now = Date.now();
      const channelMappings = JSON.stringify(input.channelMappings ?? []);
      const preferences = JSON.stringify(input.preferences ?? {});

      this.db
        .query(
          `INSERT INTO users (id, name, channel_mappings, preferences, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, channelMappings, preferences, now, now);

      const user: User = {
        id,
        name: input.name,
        channelMappings: input.channelMappings ?? [],
        preferences: input.preferences ?? {},
        createdAt: now,
        updatedAt: now,
      };

      this.logger.info("create", `Created user ${id}`, { name: input.name });
      return Ok(user);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create user", cause));
    }
  }

  /** Get a user by ID. Returns null if not found. */
  get(id: string): Result<User | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
      return Ok(row ? rowToUser(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get user ${id}`, cause));
    }
  }

  /** Update an existing user. Returns the updated user or error if not found. */
  update(id: string, input: UpdateUserInput): Result<User, EidolonError> {
    try {
      const txn = this.db.transaction(() => {
        const existing = this.db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
        if (!existing) return null;

        const now = Date.now();
        const setClauses: string[] = ["updated_at = ?"];
        const params: Array<string | number> = [now];

        if (input.name !== undefined) {
          setClauses.push("name = ?");
          params.push(input.name);
        }
        if (input.channelMappings !== undefined) {
          setClauses.push("channel_mappings = ?");
          params.push(JSON.stringify(input.channelMappings));
        }
        if (input.preferences !== undefined) {
          setClauses.push("preferences = ?");
          params.push(JSON.stringify(input.preferences));
        }

        params.push(id);
        this.db.query(`UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

        return this.db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
      });

      const updated = txn();
      if (!updated) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `User ${id} not found`));
      }
      return Ok(rowToUser(updated));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update user ${id}`, cause));
    }
  }

  /** Delete a user by ID. Cannot delete the default user. */
  delete(id: string): Result<void, EidolonError> {
    if (id === DEFAULT_USER_ID) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Cannot delete the default user"));
    }
    try {
      const txn = this.db.transaction(() => {
        const existing = this.db.query("SELECT 1 FROM users WHERE id = ?").get(id);
        if (!existing) return false;
        this.db.query("DELETE FROM users WHERE id = ?").run(id);
        return true;
      });

      const deleted = txn();
      if (!deleted) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `User ${id} not found`));
      }
      this.logger.info("delete", `Deleted user ${id}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete user ${id}`, cause));
    }
  }

  /** List all users. */
  list(): Result<User[], EidolonError> {
    try {
      const rows = this.db.query("SELECT * FROM users ORDER BY created_at ASC").all() as UserRow[];
      return Ok(rows.map(rowToUser));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list users", cause));
    }
  }

  /**
   * Find a user by channel mapping.
   * Looks up the user that has a matching (channelType, externalUserId) pair.
   */
  findByChannel(channelType: string, externalUserId: string): Result<User | null, EidolonError> {
    try {
      // Search through all users' channel mappings
      // Since channel_mappings is stored as JSON, we use a LIKE search
      // then verify in application code for correctness
      const rows = this.db
        .query("SELECT * FROM users WHERE channel_mappings LIKE ?")
        .all(`%${externalUserId}%`) as UserRow[];

      for (const row of rows) {
        const user = rowToUser(row);
        const match = user.channelMappings.find(
          (m) => m.channelType === channelType && m.externalUserId === externalUserId,
        );
        if (match) {
          return Ok(user);
        }
      }

      return Ok(null);
    } catch (cause) {
      return Err(
        createError(ErrorCode.DB_QUERY_FAILED, `Failed to find user by channel ${channelType}:${externalUserId}`, cause),
      );
    }
  }

  /** Count total users. */
  count(): Result<number, EidolonError> {
    try {
      const row = this.db.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count users", cause));
    }
  }
}
