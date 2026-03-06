# Eidolon Reviewer Agent Memory

## Review Standards
- No `any` types -- use `unknown` + narrowing
- Explicit return types on exported functions
- Zod schemas at external boundaries
- Result pattern for expected failures
- Named exports only, no default exports
- Max ~300 lines per file
- FakeClaudeProcess in tests, never real Claude Code
- Parameterized SQL, no string concatenation

## Common Review Findings
- Bare `catch {}` blocks are pervasive (~100 in production). Many are justified
  (best-effort cleanup) but some silently swallow errors that should at least log.
- Dynamic SQL column names built via string interpolation appear in store.ts and
  entities.ts. They use whitelist validation but lack explicit safety comments.
- `as TypeRow` casts from bun:sqlite queries are unavoidable (511 occurrences).
  Not a bug, but watch for missing null checks on .get() results.
- Test files use `as any` to access private methods (telegram-channel.test.ts has 49).
  This pattern is fragile -- prefer testing through public API.
- Plugin loader (plugins/loader.ts) casts JSON.parse results without Zod validation.
- Sync file I/O used in some async contexts (plugins/loader.ts, learning/journal.ts).

## Codebase Conventions
- SEC-H4 comments mark intentional console.warn usage in pre-logger startup code
- Biome is the linter (not ESLint). One stale eslint-disable exists in learning/safety.ts.
- Test structure: __tests__/ dirs co-located with source, bun:test runner
- Gateway enforces maxClients, uses constant-time token comparison, IP rate limiting
- VACUUM INTO requires string interpolation (SQLite limitation); validated via
  validateBackupPath() with FORBIDDEN_PATH_CHARS
- 225 production .ts files in core/src (excluding tests)
- Total test count: 2,488 (2,317 core + 171 CLI), 6 skips, 0 failures

## God-Modules to Watch
- daemon/initializer.ts (1,025 lines) -- initializes all 30+ modules
- daemon/event-handlers.ts (829 lines) -- all event routing
- gateway/server.ts (740 lines) -- WebSocket + HTTP handling
