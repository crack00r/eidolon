---
name: review
description: Review code changes against Eidolon project standards and conventions
context: fork
agent: Explore
allowed-tools: Read, Glob, Grep, Bash(git diff *), Bash(git log *)
---

# Code Review

Review recent code changes against Eidolon project standards.

## What to check

1. **Get the changes**: Run `git diff HEAD~1` or `git diff --staged` (whichever has content)
2. **TypeScript conventions** (see `.claude/rules/typescript.md`):
   - No `any` types
   - Explicit return types on exports
   - Zod schemas at boundaries
   - Result pattern for errors
   - Named exports only
   - Max ~300 lines per file
3. **Architecture compliance** (see `docs/design/ARCHITECTURE.md`):
   - IClaudeProcess abstraction used (not direct subprocess calls)
   - 3-database split respected
   - Circuit breakers on external calls
   - Event Bus for cross-component communication
4. **Security** (see `.claude/rules/security.md`):
   - No secrets in code
   - Parameterized SQL queries
   - Input validation with Zod
   - No `--dangerously-skip-permissions`
5. **Testing**:
   - New code has corresponding tests
   - FakeClaudeProcess used (not real Claude Code)
   - Tests use in-memory SQLite

## Output format

For each issue found:
- Severity: ERROR (must fix) / WARNING (should fix) / INFO (suggestion)
- File:line reference
- What's wrong and how to fix it

End with a summary: total issues by severity, overall assessment (approve / request changes).

If `$ARGUMENTS` is provided, review only the specified files or commits.
