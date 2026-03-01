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
(Agent will add recurring patterns here)

## Codebase Conventions
(Agent will track discovered conventions here)
