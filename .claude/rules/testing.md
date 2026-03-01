---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "packages/test-utils/**/*.ts"
---

# Testing Conventions (Eidolon)

## Framework

- Use `bun:test` exclusively: `describe`, `it`, `expect`, `mock`, `spyOn`, `beforeEach`, `afterEach`.
- Test files live next to source: `src/foo.ts` -> `src/foo.test.ts`, or in a `test/` directory mirroring `src/`.
- Run tests: `bun test` (single package) or `pnpm -r test` (all packages).

## IClaudeProcess & FakeClaudeProcess

- **Never** spawn real Claude Code processes in tests. Always use `FakeClaudeProcess` from `@eidolon/test-utils`.
- `FakeClaudeProcess` implements `IClaudeProcess` and allows scripting responses, simulating errors, and asserting on session parameters.
- Test all session types: main loop, research, code generation, memory extraction.

## Database Tests

- Use in-memory SQLite (`:memory:`) for all database tests.
- Run migrations before each test suite. Tear down after.
- Never share database state between test cases -- each test gets a fresh database.

## Patterns

- **Arrange-Act-Assert** structure. Keep tests focused on one behavior.
- Use descriptive test names: `it("should reject config with missing required fields")`.
- Test error paths, not just happy paths. Expected failures should return `Result.error`, not throw.
- Mock external boundaries (filesystem, network, subprocess) at the interface level.
- Use `beforeEach` for setup, `afterEach` for cleanup. Never rely on test execution order.

## Coverage Targets

- Core packages: aim for >80% line coverage on critical paths (loop, memory, security).
- CLI: test command parsing and output formatting. Integration tests for daemon lifecycle.
- Protocol: 100% coverage on Zod schema validation (all valid + invalid inputs).

## CI Integration

- All tests must pass in CI before merge. No `it.skip` without a linked issue.
- Tests must complete within 30 seconds per package. Flag slow tests for optimization.
- No network calls in unit tests. Use mocks or test fixtures.
