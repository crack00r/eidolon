# Eidolon Coder Agent Memory

## Key File Locations
- Protocol types (Claude): `packages/protocol/src/types/claude.ts` (StreamEvent, ClaudeSessionOptions, IClaudeProcess)
- Protocol types (Events): `packages/protocol/src/types/events.ts` (BusEvent, EventType)
- Claude args builder: `packages/core/src/claude/args.ts` (buildClaudeArgs)
- Claude stream parser: `packages/core/src/claude/parser.ts` (parseStreamLine, parseStreamOutput)
- Claude manager: `packages/core/src/claude/manager.ts` (ClaudeCodeManager)
- Tests follow pattern: `src/claude/__tests__/<module>.test.ts`

## Patterns
- StreamEvent uses a union type string for `type` field, with optional fields per type
- `buildClaudeArgs` returns `readonly string[]`, does NOT include the `claude` binary name
- `parseStreamLine` supports an optional `extraEvents` out-parameter array for emitting additional events
- ClaudeCodeManager uses Bun.spawn() with safe env whitelisting (SAFE_ENV_KEYS + SAFE_ENV_PREFIXES)
- Test helper: `makeOptions()` creates ClaudeSessionOptions with workspaceDir default

## Test Suite Stats
- Core: 3068 pass, 6 skip, 199 test files
- Protocol: 100 pass, 1 test file
