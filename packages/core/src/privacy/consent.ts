/**
 * GDPR consent management.
 *
 * Stores and retrieves consent state from the `user_consent` table in operational.db.
 * Memory extraction MUST check consent before processing conversation data.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsentType = "memory_extraction" | "data_processing";

export interface ConsentStatus {
  readonly consentType: ConsentType;
  readonly granted: boolean;
  readonly grantedAt: number | null;
  readonly revokedAt: number | null;
  readonly updatedAt: number;
}

interface ConsentRow {
  id: string;
  consent_type: string;
  granted: number;
  granted_at: number | null;
  revoked_at: number | null;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Consent Manager
// ---------------------------------------------------------------------------

export class ConsentManager {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("consent");
  }

  /**
   * Check if consent has been granted for a specific consent type.
   * Returns false if no consent record exists (consent must be explicit).
   */
  checkConsentStatus(consentType: ConsentType): boolean {
    try {
      const row = this.db.query("SELECT granted FROM user_consent WHERE consent_type = ?").get(consentType) as {
        granted: number;
      } | null;

      return row !== null && row.granted === 1;
    } catch {
      // If the table doesn't exist yet (pre-migration), treat as no consent
      return false;
    }
  }

  /**
   * Get full consent status details for a specific type.
   */
  getConsentStatus(consentType: ConsentType): Result<ConsentStatus | null, EidolonError> {
    try {
      const row = this.db
        .query(
          "SELECT id, consent_type, granted, granted_at, revoked_at, updated_at FROM user_consent WHERE consent_type = ?",
        )
        .get(consentType) as ConsentRow | null;

      if (!row) {
        return Ok(null);
      }

      return Ok({
        consentType: row.consent_type as ConsentType,
        granted: row.granted === 1,
        grantedAt: row.granted_at,
        revokedAt: row.revoked_at,
        updatedAt: row.updated_at,
      });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get consent status", cause));
    }
  }

  /**
   * Grant consent for a specific type.
   */
  grantConsent(consentType: ConsentType): Result<void, EidolonError> {
    try {
      const now = Date.now();
      const existing = this.db.query("SELECT id FROM user_consent WHERE consent_type = ?").get(consentType) as {
        id: string;
      } | null;

      if (existing) {
        this.db
          .query(
            "UPDATE user_consent SET granted = 1, granted_at = ?, revoked_at = NULL, updated_at = ? WHERE consent_type = ?",
          )
          .run(now, now, consentType);
      } else {
        this.db
          .query(
            "INSERT INTO user_consent (id, consent_type, granted, granted_at, revoked_at, updated_at) VALUES (?, ?, 1, ?, NULL, ?)",
          )
          .run(randomUUID(), consentType, now, now);
      }

      this.logger.info("consent", `Consent granted for ${consentType}`, { consentType, timestamp: now });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to grant consent", cause));
    }
  }

  /**
   * Revoke consent for a specific type.
   */
  revokeConsent(consentType: ConsentType): Result<void, EidolonError> {
    try {
      const now = Date.now();
      const existing = this.db.query("SELECT id FROM user_consent WHERE consent_type = ?").get(consentType) as {
        id: string;
      } | null;

      if (existing) {
        this.db
          .query("UPDATE user_consent SET granted = 0, revoked_at = ?, updated_at = ? WHERE consent_type = ?")
          .run(now, now, consentType);
      } else {
        this.db
          .query(
            "INSERT INTO user_consent (id, consent_type, granted, granted_at, revoked_at, updated_at) VALUES (?, ?, 0, NULL, ?, ?)",
          )
          .run(randomUUID(), consentType, now, now);
      }

      this.logger.info("consent", `Consent revoked for ${consentType}`, { consentType, timestamp: now });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to revoke consent", cause));
    }
  }
}
