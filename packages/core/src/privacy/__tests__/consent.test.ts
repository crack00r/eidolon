import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isErr, isOk } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { ConsentType } from "../consent.ts";
import { ConsentManager } from "../consent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE user_consent (
      id TEXT PRIMARY KEY,
      consent_type TEXT NOT NULL CHECK(consent_type IN ('memory_extraction','data_processing')),
      granted INTEGER NOT NULL CHECK(granted IN (0, 1)),
      granted_at INTEGER,
      revoked_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.run("CREATE UNIQUE INDEX idx_user_consent_type ON user_consent(consent_type)");
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConsentManager", () => {
  const logger = createSilentLogger();
  let db: Database;
  let manager: ConsentManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new ConsentManager(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // checkConsentStatus
  // -------------------------------------------------------------------------

  describe("checkConsentStatus", () => {
    test("returns false when no consent record exists", () => {
      expect(manager.checkConsentStatus("memory_extraction")).toBe(false);
    });

    test("returns true after consent is granted", () => {
      manager.grantConsent("memory_extraction");
      expect(manager.checkConsentStatus("memory_extraction")).toBe(true);
    });

    test("returns false after consent is revoked", () => {
      manager.grantConsent("data_processing");
      manager.revokeConsent("data_processing");
      expect(manager.checkConsentStatus("data_processing")).toBe(false);
    });

    test("returns false when table does not exist (pre-migration)", () => {
      const rawDb = new Database(":memory:");
      const mgr = new ConsentManager(rawDb, logger);
      expect(mgr.checkConsentStatus("memory_extraction")).toBe(false);
      rawDb.close();
    });

    test("consent types are independent", () => {
      manager.grantConsent("memory_extraction");
      expect(manager.checkConsentStatus("memory_extraction")).toBe(true);
      expect(manager.checkConsentStatus("data_processing")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getConsentStatus
  // -------------------------------------------------------------------------

  describe("getConsentStatus", () => {
    test("returns null when no record exists", () => {
      const result = manager.getConsentStatus("memory_extraction");
      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBeNull();
      }
    });

    test("returns full status after granting consent", () => {
      const beforeGrant = Date.now();
      manager.grantConsent("memory_extraction");
      const afterGrant = Date.now();

      const result = manager.getConsentStatus("memory_extraction");
      expect(isOk(result)).toBe(true);
      if (isOk(result) && result.value !== null) {
        const status = result.value;
        expect(status.consentType).toBe("memory_extraction");
        expect(status.granted).toBe(true);
        expect(status.grantedAt).toBeGreaterThanOrEqual(beforeGrant);
        expect(status.grantedAt).toBeLessThanOrEqual(afterGrant);
        expect(status.revokedAt).toBeNull();
        expect(status.updatedAt).toBeGreaterThanOrEqual(beforeGrant);
      }
    });

    test("returns full status after revoking consent", () => {
      manager.grantConsent("data_processing");
      const beforeRevoke = Date.now();
      manager.revokeConsent("data_processing");
      const afterRevoke = Date.now();

      const result = manager.getConsentStatus("data_processing");
      expect(isOk(result)).toBe(true);
      if (isOk(result) && result.value !== null) {
        const status = result.value;
        expect(status.consentType).toBe("data_processing");
        expect(status.granted).toBe(false);
        expect(status.revokedAt).toBeGreaterThanOrEqual(beforeRevoke);
        expect(status.revokedAt).toBeLessThanOrEqual(afterRevoke);
      }
    });

    test("returns Err when database query fails", () => {
      db.close();
      const result = manager.getConsentStatus("memory_extraction");
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("DB_QUERY_FAILED");
      }
    });
  });

  // -------------------------------------------------------------------------
  // grantConsent
  // -------------------------------------------------------------------------

  describe("grantConsent", () => {
    test("creates a new consent record when none exists", () => {
      const result = manager.grantConsent("memory_extraction");
      expect(isOk(result)).toBe(true);

      const row = db.query("SELECT * FROM user_consent WHERE consent_type = ?").get("memory_extraction") as Record<
        string,
        unknown
      >;
      expect(row).not.toBeNull();
      expect(row.granted).toBe(1);
      expect(row.granted_at).not.toBeNull();
      expect(row.revoked_at).toBeNull();
      // id should be a UUID string
      expect(typeof row.id).toBe("string");
      expect((row.id as string).length).toBeGreaterThan(0);
    });

    test("re-grants consent after it was revoked", () => {
      manager.grantConsent("data_processing");
      manager.revokeConsent("data_processing");

      // Verify it is revoked
      expect(manager.checkConsentStatus("data_processing")).toBe(false);

      // Re-grant
      const result = manager.grantConsent("data_processing");
      expect(isOk(result)).toBe(true);
      expect(manager.checkConsentStatus("data_processing")).toBe(true);

      // revokedAt should be cleared on re-grant
      const status = manager.getConsentStatus("data_processing");
      if (isOk(status) && status.value !== null) {
        expect(status.value.revokedAt).toBeNull();
        expect(status.value.grantedAt).not.toBeNull();
      }
    });

    test("updates timestamps when re-granting", () => {
      manager.grantConsent("memory_extraction");
      const firstStatus = manager.getConsentStatus("memory_extraction");
      const firstGrantedAt = isOk(firstStatus) && firstStatus.value ? firstStatus.value.grantedAt : 0;

      // Revoke and re-grant
      manager.revokeConsent("memory_extraction");
      manager.grantConsent("memory_extraction");

      const secondStatus = manager.getConsentStatus("memory_extraction");
      if (isOk(secondStatus) && secondStatus.value) {
        expect(secondStatus.value.grantedAt).toBeGreaterThanOrEqual(firstGrantedAt as number);
        expect(secondStatus.value.updatedAt).toBeGreaterThanOrEqual(firstGrantedAt as number);
      }
    });

    test("returns Err when database is closed", () => {
      db.close();
      const result = manager.grantConsent("memory_extraction");
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("DB_QUERY_FAILED");
      }
    });
  });

  // -------------------------------------------------------------------------
  // revokeConsent
  // -------------------------------------------------------------------------

  describe("revokeConsent", () => {
    test("revokes existing granted consent", () => {
      manager.grantConsent("memory_extraction");
      const result = manager.revokeConsent("memory_extraction");
      expect(isOk(result)).toBe(true);
      expect(manager.checkConsentStatus("memory_extraction")).toBe(false);
    });

    test("creates a revoked record when no prior consent exists", () => {
      // Revoking without prior grant should still create a record
      const result = manager.revokeConsent("data_processing");
      expect(isOk(result)).toBe(true);

      const row = db.query("SELECT * FROM user_consent WHERE consent_type = ?").get("data_processing") as Record<
        string,
        unknown
      >;
      expect(row).not.toBeNull();
      expect(row.granted).toBe(0);
      expect(row.granted_at).toBeNull();
      expect(row.revoked_at).not.toBeNull();
    });

    test("sets revokedAt timestamp when revoking", () => {
      manager.grantConsent("memory_extraction");
      const beforeRevoke = Date.now();
      manager.revokeConsent("memory_extraction");
      const afterRevoke = Date.now();

      const status = manager.getConsentStatus("memory_extraction");
      if (isOk(status) && status.value) {
        expect(status.value.revokedAt).toBeGreaterThanOrEqual(beforeRevoke);
        expect(status.value.revokedAt).toBeLessThanOrEqual(afterRevoke);
      }
    });

    test("returns Err when database is closed", () => {
      db.close();
      const result = manager.revokeConsent("memory_extraction");
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe("DB_QUERY_FAILED");
      }
    });
  });

  // -------------------------------------------------------------------------
  // GDPR Article 7 compliance: withdrawal must be as easy as granting
  // -------------------------------------------------------------------------

  describe("GDPR Article 7 compliance", () => {
    test("granting and revoking consent use symmetric operations", () => {
      // Grant consent
      const grantResult = manager.grantConsent("memory_extraction");
      expect(isOk(grantResult)).toBe(true);
      expect(manager.checkConsentStatus("memory_extraction")).toBe(true);

      // Revoke consent -- equally simple, single call
      const revokeResult = manager.revokeConsent("memory_extraction");
      expect(isOk(revokeResult)).toBe(true);
      expect(manager.checkConsentStatus("memory_extraction")).toBe(false);
    });

    test("consent is not granted by default (must be explicit)", () => {
      // GDPR requires affirmative consent -- silence or inaction does not equal consent
      expect(manager.checkConsentStatus("memory_extraction")).toBe(false);
      expect(manager.checkConsentStatus("data_processing")).toBe(false);
    });

    test("multiple grant-revoke cycles work correctly", () => {
      for (let i = 0; i < 5; i++) {
        manager.grantConsent("memory_extraction");
        expect(manager.checkConsentStatus("memory_extraction")).toBe(true);
        manager.revokeConsent("memory_extraction");
        expect(manager.checkConsentStatus("memory_extraction")).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  describe("persistence", () => {
    test("consent survives creating a new ConsentManager on the same database", () => {
      manager.grantConsent("memory_extraction");
      manager.revokeConsent("data_processing");

      // Create a new manager on the same db (simulates daemon restart)
      const manager2 = new ConsentManager(db, logger);
      expect(manager2.checkConsentStatus("memory_extraction")).toBe(true);
      expect(manager2.checkConsentStatus("data_processing")).toBe(false);

      const status = manager2.getConsentStatus("data_processing");
      if (isOk(status) && status.value) {
        expect(status.value.granted).toBe(false);
        expect(status.value.revokedAt).not.toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Both consent types
  // -------------------------------------------------------------------------

  describe("all consent types", () => {
    const consentTypes: ConsentType[] = ["memory_extraction", "data_processing"];

    for (const consentType of consentTypes) {
      test(`grant and check works for ${consentType}`, () => {
        manager.grantConsent(consentType);
        expect(manager.checkConsentStatus(consentType)).toBe(true);
      });

      test(`revoke and check works for ${consentType}`, () => {
        manager.grantConsent(consentType);
        manager.revokeConsent(consentType);
        expect(manager.checkConsentStatus(consentType)).toBe(false);
      });
    }
  });
});
