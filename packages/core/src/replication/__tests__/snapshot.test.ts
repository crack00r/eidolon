/**
 * Tests for snapshot creation and receiving.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger } from "../../logging/logger.ts";
import { chunkSnapshotFile, createSnapshot, createSnapshotReceiver } from "../snapshot.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dir, ".tmp-snapshot-test");

function makeLogger() {
  return createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 });
}

/** Create a minimal DatabaseManager-like object with real in-file databases. */
function createTestDbs(dir: string) {
  mkdirSync(dir, { recursive: true });

  const memPath = join(dir, "memory.db");
  const opPath = join(dir, "operational.db");
  const auditPath = join(dir, "audit.db");

  const memory = new Database(memPath, { create: true });
  memory.run("CREATE TABLE IF NOT EXISTS test_mem (id INTEGER PRIMARY KEY, data TEXT)");
  memory.run("INSERT INTO test_mem (data) VALUES ('memory_data')");

  const operational = new Database(opPath, { create: true });
  operational.run("CREATE TABLE IF NOT EXISTS test_op (id INTEGER PRIMARY KEY, data TEXT)");
  operational.run("INSERT INTO test_op (data) VALUES ('operational_data')");

  const audit = new Database(auditPath, { create: true });
  audit.run("CREATE TABLE IF NOT EXISTS test_audit (id INTEGER PRIMARY KEY, data TEXT)");
  audit.run("INSERT INTO test_audit (data) VALUES ('audit_data')");

  return {
    memory,
    operational,
    audit,
    close() {
      memory.close();
      operational.close();
      audit.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Snapshot", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("createSnapshot", () => {
    test("creates snapshots for all 3 databases", () => {
      const dbDir = join(TEST_DIR, "dbs");
      const snapshotDir = join(TEST_DIR, "snapshots");
      const dbs = createTestDbs(dbDir);

      const result = createSnapshot(dbs as never, snapshotDir, makeLogger());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.files).toHaveLength(3);
        expect(result.value.totalBytes).toBeGreaterThan(0);

        for (const file of result.value.files) {
          expect(existsSync(file.path)).toBe(true);
          expect(file.sizeBytes).toBeGreaterThan(0);
          expect(file.checksum).toMatch(/^[a-f0-9]{64}$/);
        }
      }

      dbs.close();
    });
  });

  describe("chunkSnapshotFile", () => {
    test("chunks a file into base64 segments", () => {
      const dbDir = join(TEST_DIR, "dbs");
      const snapshotDir = join(TEST_DIR, "snapshots");
      const dbs = createTestDbs(dbDir);

      const snapResult = createSnapshot(dbs as never, snapshotDir, makeLogger());
      expect(snapResult.ok).toBe(true);
      if (!snapResult.ok) return;

      const firstFile = snapResult.value.files[0];
      expect(firstFile).toBeDefined();
      if (!firstFile) return;
      const chunkResult = chunkSnapshotFile(firstFile.path, firstFile.fileName);

      expect(chunkResult.ok).toBe(true);
      if (chunkResult.ok) {
        expect(chunkResult.value.length).toBeGreaterThanOrEqual(1);
        for (const chunk of chunkResult.value) {
          expect(chunk.fileName).toBe(firstFile.fileName);
          expect(chunk.data.length).toBeGreaterThan(0);
        }
      }

      dbs.close();
    });

    test("returns error for non-existent file", () => {
      const result = chunkSnapshotFile("/nonexistent/file.db", "file.db");
      expect(result.ok).toBe(false);
    });
  });

  describe("SnapshotReceiver", () => {
    test("receives and finalizes chunks with checksum verification", () => {
      const dbDir = join(TEST_DIR, "dbs");
      const snapshotDir = join(TEST_DIR, "snapshots");
      const receiveDir = join(TEST_DIR, "received");
      const dbs = createTestDbs(dbDir);

      // Create snapshot on primary side
      const snapResult = createSnapshot(dbs as never, snapshotDir, makeLogger());
      expect(snapResult.ok).toBe(true);
      if (!snapResult.ok) return;

      // Simulate transfer to secondary
      const receiver = createSnapshotReceiver(receiveDir, makeLogger());
      const snap = snapResult.value;

      receiver.begin(snap.files.length, snap.totalBytes);
      expect(receiver.inProgress).toBe(true);

      const checksums: Record<string, string> = {};
      for (const file of snap.files) {
        const chunkResult = chunkSnapshotFile(file.path, file.fileName);
        expect(chunkResult.ok).toBe(true);
        if (!chunkResult.ok) continue;

        checksums[file.fileName] = file.checksum;
        for (const chunk of chunkResult.value) {
          receiver.receiveChunk(chunk.fileName, chunk.chunkIndex, chunk.totalChunks, chunk.data);
        }
      }

      const finalizeResult = receiver.finalize(checksums);
      expect(finalizeResult.ok).toBe(true);
      expect(receiver.inProgress).toBe(false);

      // Verify files exist in receive directory
      for (const file of snap.files) {
        const receivedPath = join(receiveDir, file.fileName);
        expect(existsSync(receivedPath)).toBe(true);

        // Verify content matches
        const receivedData = readFileSync(receivedPath);
        const receivedChecksum = createHash("sha256").update(receivedData).digest("hex");
        expect(receivedChecksum).toBe(file.checksum);
      }

      dbs.close();
    });

    test("rejects finalize when not in progress", () => {
      const receiveDir = join(TEST_DIR, "received");
      const receiver = createSnapshotReceiver(receiveDir, makeLogger());

      const result = receiver.finalize({});
      expect(result.ok).toBe(false);
    });

    test("rejects finalize with checksum mismatch", () => {
      const receiveDir = join(TEST_DIR, "received");
      const receiver = createSnapshotReceiver(receiveDir, makeLogger());

      receiver.begin(1, 100);
      receiver.receiveChunk("test.db", 0, 1, Buffer.from("test data").toString("base64"));

      const result = receiver.finalize({ "test.db": "wrong_checksum" });
      expect(result.ok).toBe(false);
    });
  });
});
