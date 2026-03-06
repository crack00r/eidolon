# Eidolon Tester Agent Memory

## Test Infrastructure
- Framework: bun:test (describe, it, expect, mock, spyOn)
- Claude mock: FakeClaudeProcess from @eidolon/test-utils
- Database: in-memory SQLite (:memory:) per test

## Testing Patterns
- Router tests use `createSilentLogger()` (noop logger) and in-memory SQLite for EventBus
- DND tests use the `nowProvider` injectable clock -- construct fixed UTC dates with `new Date(Date.UTC(...))`
- `isDndActive()` is exported and can be tested independently from `MessageRouter`
- Mock channels: `createMockChannel(id)` returns a Channel with `.sentMessages` array
- For timezone tests, always use `Date.UTC()` to construct exact UTC timestamps
- The DND window uses inclusive start, exclusive end: `[start, end)`
- Cross-midnight windows (start > end) use `>=start || <end` logic
- `Intl.DateTimeFormat` with `timeZone` option handles DST transitions automatically

## Coverage Notes
- router.ts: well covered -- DND logic, timezone, cross-midnight, same-day, boundaries, DST, integration
- DND timezone tests cover: Europe/Berlin (CET/CEST), America/New_York (EST/EDT), Asia/Tokyo (no DST), America/St_Johns (half-hour offset)
- DST transition tests verify both spring forward and fall back for Berlin and NYC
- audit/logger.ts: fully covered (32 tests) -- log, query with all filters, hash chain, append-only, tamper detection, volume

## Audit Logger Testing
- Schema: apply all 3 migrations with db.run() (table, indexes, integrity hash + triggers)
- Tamper test: drop trigger, modify data, re-create trigger, verify integrity fails
- Append-only: UPDATE and DELETE throw trigger error messages
- AuditLogger constructor: (db: Database, logger: Logger)
