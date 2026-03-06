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

## EventBus Backpressure Testing
- EventBus accepts `maxPendingEvents` option (default 1000 from `DEFAULT_MAX_PENDING_EVENTS`)
- Backpressure drops normal/low events when `pendingCount() >= maxPendingEvents`
- Critical and high priority events are NEVER dropped (bypass check entirely)
- Dropped events return `Err` with `EVENT_BUS_ERROR` code and are not persisted to DB
- Recovery: after `markProcessed()` shrinks queue below threshold, low-priority events accepted again
- Test DB setup: use `runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger)`

## HA Policy Testing
- HAPolicyChecker constructor: `(config: HomeAutomationConfig, logger: Logger)`
- `checkPolicy(domain, entityId?, service?)` returns `Result<PolicyCheckResult, never>` (always Ok)
- Resolution order: entity exception > domain policy > "needs_approval" fallback for unknown
- HAManager.executeService blocks "dangerous" actions (returns `HA_POLICY_DENIED`), allows "needs_approval"
- HA test DB needs: `ha_entities` and `ha_scenes` tables (create manually, no migration runner)
- Mock EventBus pattern: object with `published` array, stubbed methods, cast `as unknown as EventBus`

## Golden Dataset Testing
- Extraction golden dataset: `packages/core/test/fixtures/golden/extraction/conversations.json` (105 turns, 9 categories)
- Search golden dataset: `packages/core/test/fixtures/golden/search/queries.json` (35 queries, 6 categories)
- Extraction test: `packages/core/src/memory/__tests__/extraction-golden.test.ts` (7 tests)
- Search structure test: `packages/core/src/memory/__tests__/search-golden.test.ts` (13 tests, validates dataset structure only)
- Search relevance test: `packages/core/src/memory/__tests__/search-relevance.test.ts` (14 tests, validates actual search against golden entries)
- Rule-based precision: ~79.5%, recall: ~30.1% (facts low at 5.7%, corrections high at 88.9%)
- `contentMatches()` helper uses case-insensitive substring + 60% word overlap for fuzzy matching
- `categoryMatches()` maps extractor types/tags to golden dataset categories (corrections=fact+tag:correction)
- Thresholds set conservatively: precision>=40%, recall>=25% for rule-based (no LLM)
- Golden dataset `_note` field in expected explains edge-case reasoning

## MemorySearch BM25 Behavior (CRITICAL)
- `MemoryStore.searchText()` wraps query in double quotes for FTS5: `"${query}"` (exact phrase match)
- This means natural language questions will NOT match unless the exact word sequence appears in content
- To test BM25 search, use phrase queries that are consecutive word subsequences of memory content
- Example: query "package manager" matches content "pnpm workspaces is the package manager"
- Example: query "What is the package manager?" does NOT match (no content has that exact phrase)
- StubEmbeddingModel with `isInitialized=false` forces BM25-only mode (no vector search)

## Audit Logger Testing
- Schema: apply all 3 migrations with db.run() (table, indexes, integrity hash + triggers)
- Tamper test: drop trigger, modify data, re-create trigger, verify integrity fails
- Append-only: UPDATE and DELETE throw trigger error messages
- AuditLogger constructor: (db: Database, logger: Logger)
