---
name: review
description: Review code changes against Eidolon project standards and conventions
context: fork
agent: eidolon-reviewer
allowed-tools: Read, Glob, Grep, Bash(git diff *), Bash(git log *)
---

# Code Review

Review recent code changes against Eidolon project standards.

1. Run `git diff HEAD~1` or `git diff --staged` to get the changes
2. Read all changed files in full context
3. Check against all project standards:
   - TypeScript conventions (`.claude/rules/typescript.md`)
   - Architecture rules (`docs/design/ARCHITECTURE.md`)
   - Security rules (`.claude/rules/security.md`)
   - Testing requirements (`.claude/rules/testing.md`)
4. Report findings grouped by severity (ERROR / WARNING / INFO)
5. End with summary counts and verdict (APPROVE / REQUEST CHANGES)

If `$ARGUMENTS` is provided, review only the specified files or commits.
