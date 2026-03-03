# Eidolon Debugger Agent Memory

## Common Error Patterns
- **Bun test "Export named X not found"**: When `bun test` reports a missing export from `@eidolon/core`, check the preload mock at `packages/cli/src/__tests__/preload.ts`. The preload provides a global mock for `@eidolon/core` because Bun 1.3.9 cannot resolve `export *` barrel re-exports across pnpm workspaces in test context. When new exports are added to core and used by CLI commands, they MUST also be added to the preload mock AND to the per-test `mock.module` in `commands.test.ts`.
- **`noUncheckedIndexedAccess` with regex matches**: `RegExp.exec()` returns `(string | undefined)[]` for capture groups. Always add explicit undefined checks for `match[1]`, `match[2]`, etc. before using them.

## Diagnostic Techniques
- Type errors: run `pnpm -r typecheck`, check tsconfig paths
- Test failures: run `bun test --bail` to isolate first failure
- SQLite issues: check migration state, verify 3-database split

## Resolved Issues Log
- **2026-03-03**: Fixed CLI learning command -- 3 TypeScript errors in `packages/cli/src/commands/learning.ts` (noUncheckedIndexedAccess on regex captures and array access) + test import failure caused by missing `DiscoveryEngine`/`LearningJournal` mocks in `packages/cli/src/__tests__/preload.ts`.
