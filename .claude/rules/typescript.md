---
paths:
  - "packages/**/*.ts"
  - "packages/**/*.tsx"
  - "apps/**/*.ts"
  - "apps/**/*.tsx"
---

# TypeScript Conventions (Eidolon)

## Types & Safety

- Never use `any`. Use `unknown` and narrow with type guards or Zod `.parse()`.
- Explicit return types on all exported functions and methods.
- Prefer `interface` for object shapes, `type` for unions/intersections/utility types.
- Use `readonly` on arrays and objects that should not be mutated.
- Use `satisfies` operator for type-safe object literals where inference is needed.

## Patterns

- **Result pattern** for expected failures: `type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }`.
- Throw only for programming bugs (invariant violations), never for expected errors.
- Use Zod schemas for all external data boundaries: config files, API responses, IPC messages, CLI args.
- Derive TypeScript types from Zod schemas with `z.infer<typeof Schema>`.

## Bun-Specific

- Use `bun:sqlite` for database access (not better-sqlite3).
- Use `bun:test` for tests (describe, it, expect, mock, spyOn).
- Use `Bun.serve()` for HTTP servers, not Express or Fastify.
- Use `Bun.spawn()` / `Bun.spawnSync()` for subprocess management.
- Path aliases: `@eidolon/core`, `@eidolon/protocol`, `@eidolon/cli`, `@eidolon/test-utils`.

## Structure

- Max ~300 lines per file. Split into modules when exceeding.
- Named exports only. No default exports.
- Group imports: external deps, then internal aliases, then relative.
- One class/interface per file when the type is the primary export.

## Naming

- `camelCase` for variables, functions, parameters.
- `PascalCase` for types, interfaces, classes, enums.
- `UPPER_SNAKE_CASE` for constants and environment variable keys.
- Prefix interfaces with `I` only for abstractions with multiple implementations (e.g., `IClaudeProcess`).
- Suffix error classes with `Error` (e.g., `ConfigValidationError`).
