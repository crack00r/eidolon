/**
 * GDPR audit log erasure utility.
 *
 * The audit_log table is protected by the `audit_no_delete` trigger (migration v3)
 * to ensure tamper-proof append-only behavior during normal operation. However,
 * GDPR Article 17 ("right to erasure") requires the ability to delete personal
 * data on request. This utility temporarily drops the trigger within a transaction
 * to allow controlled deletion of audit records.
 *
 * This function should ONLY be called as part of a verified GDPR erasure request.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Trigger SQL (must match migration v3 in audit.ts)
// ---------------------------------------------------------------------------

const DROP_TRIGGER_SQL = "DROP TRIGGER IF EXISTS audit_no_delete";

const CREATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS audit_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'Audit log entries cannot be deleted');
    END
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Delete audit log records matching a WHERE clause, temporarily bypassing
 * the tamper-protection trigger.
 *
 * @param db      - The audit database connection.
 * @param filter  - SQL WHERE clause (without the WHERE keyword), e.g. `"target LIKE ?"`.
 * @param params  - Bind parameters for the filter clause.
 * @returns The number of deleted rows on success.
 *
 * @security This function drops and recreates the audit_no_delete trigger
 *           within a single transaction. If the transaction fails, the trigger
 *           is restored via rollback.
 */
/** Whitelist of column names allowed in GDPR filter clauses. */
const ALLOWED_FILTER_COLUMNS = new Set(["target", "action", "timestamp", "id", "actor"]);

/** Pattern for a single safe filter clause: column operator placeholder. */
const SAFE_CLAUSE_PATTERN = /^(target|action|timestamp|id|actor)\s+(=|LIKE)\s+\?$/i;

/**
 * Validate that a GDPR filter string only contains safe, whitelisted clauses.
 * Each AND-separated clause must match: allowed_column (=|LIKE) ?
 */
function validateFilter(filter: string): Result<void, EidolonError> {
  const clauses = filter.split(/\s+AND\s+/i);
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!SAFE_CLAUSE_PATTERN.test(trimmed)) {
      return Err(
        createError(
          ErrorCode.INVALID_INPUT,
          `Unsafe GDPR filter clause rejected: "${trimmed}". Only columns [${[...ALLOWED_FILTER_COLUMNS].join(", ")}] with operators [=, LIKE] and ? placeholders are allowed.`,
        ),
      );
    }
  }
  return Ok(undefined);
}

export function gdprEraseAuditRecords(
  db: Database,
  filter: string,
  params: readonly (string | number)[],
): Result<number, EidolonError> {
  if (!filter.trim()) {
    return Err(
      createError(ErrorCode.INVALID_INPUT, "GDPR audit erasure requires a non-empty filter clause"),
    );
  }

  const validationResult = validateFilter(filter);
  if (!validationResult.ok) return validationResult;

  try {
    const txn = db.transaction(() => {
      // 1. Drop the tamper-protection trigger
      db.exec(DROP_TRIGGER_SQL);

      // 2. Delete matching records
      const result = db.query(`DELETE FROM audit_log WHERE ${filter}`).run(...params);

      // 3. Recreate the trigger
      db.exec(CREATE_TRIGGER_SQL);

      return result.changes;
    });

    const deletedCount = txn();
    return Ok(deletedCount);
  } catch (cause) {
    // If the transaction rolled back, the trigger is still in its original state.
    // Attempt to ensure it exists as a safety measure.
    try {
      db.exec(CREATE_TRIGGER_SQL);
    } catch {
      // Best-effort: trigger recreation may fail if DB is in bad state
    }
    return Err(
      createError(ErrorCode.DB_QUERY_FAILED, "Failed to erase audit records for GDPR compliance", cause),
    );
  }
}
