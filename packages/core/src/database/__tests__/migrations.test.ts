import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Migration } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.js";
import { runMigrations } from "../migrations.js";

const TEST_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "create_users",
    database: "operational",
    up: "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);",
    down: "DROP TABLE IF EXISTS users;",
  },
  {
    version: 2,
    name: "create_posts",
    database: "operational",
    up: "CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL);",
    down: "DROP TABLE IF EXISTS posts;",
  },
  {
    version: 3,
    name: "memory_only_migration",
    database: "memory",
    up: "CREATE TABLE notes (id TEXT PRIMARY KEY);",
    down: "DROP TABLE IF EXISTS notes;",
  },
];

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

describe("runMigrations", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeDb(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  test("applies migrations in order", () => {
    const db = makeDb();
    const result = runMigrations(db, "operational", TEST_MIGRATIONS, logger);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(2); // Only 2 operational migrations
    }

    // Verify tables exist
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_*' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("posts");
  });

  test("skips already-applied migrations (idempotent)", () => {
    const db = makeDb();

    const first = runMigrations(db, "operational", TEST_MIGRATIONS, logger);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toBe(2);

    const second = runMigrations(db, "operational", TEST_MIGRATIONS, logger);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBe(0);
  });

  test("records migrations in _migrations table", () => {
    const db = makeDb();
    runMigrations(db, "operational", TEST_MIGRATIONS, logger);

    const rows = db.query("SELECT version, name FROM _migrations ORDER BY version").all() as Array<{
      version: number;
      name: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.name).toBe("create_users");
    expect(rows[1]?.version).toBe(2);
    expect(rows[1]?.name).toBe("create_posts");
  });

  test("rolls back failed migration", () => {
    const db = makeDb();
    const badMigrations: ReadonlyArray<Migration> = [
      {
        version: 1,
        name: "good_migration",
        database: "operational",
        up: "CREATE TABLE good (id TEXT PRIMARY KEY);",
        down: "DROP TABLE IF EXISTS good;",
      },
      {
        version: 2,
        name: "bad_migration",
        database: "operational",
        up: "THIS IS NOT VALID SQL;",
        down: "",
      },
    ];

    const result = runMigrations(db, "operational", badMigrations, logger);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DB_MIGRATION_FAILED");
      expect(result.error.message).toContain("bad_migration");
    }

    // First migration should have succeeded
    const rows = db.query("SELECT version FROM _migrations").all() as Array<{ version: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });

  test("only applies migrations for the specified database", () => {
    const db = makeDb();
    const result = runMigrations(db, "memory", TEST_MIGRATIONS, logger);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1); // Only 1 memory migration
    }

    // Verify only the memory table exists
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_*'").all() as Array<{
      name: string;
    }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("notes");
    expect(tableNames).not.toContain("users");
    expect(tableNames).not.toContain("posts");
  });

  test("returns Ok(0) when no migrations match", () => {
    const db = makeDb();
    const result = runMigrations(db, "audit", TEST_MIGRATIONS, logger);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });
});
