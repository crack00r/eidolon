---
name: fix-issue
description: Fix a GitHub issue by number -- analyze, implement, test, and commit
disable-model-invocation: true
argument-hint: "[issue-number]"
---

# Fix GitHub Issue

Fix GitHub issue #$ARGUMENTS following Eidolon project standards.

## Steps

1. **Fetch the issue**: Run `gh issue view $ARGUMENTS` to read the full description, labels, and comments
2. **Analyze**: Determine what needs to change and which files are affected
3. **Plan**: List the changes needed before writing any code
4. **Implement**: Make the changes following project conventions:
   - TypeScript rules from `.claude/rules/typescript.md`
   - Security rules from `.claude/rules/security.md`
   - Use Result pattern for error handling
   - Use Zod for any new external data boundaries
5. **Test**: Write or update tests for the changes
   - Use `bun test` to verify all tests pass
   - Use FakeClaudeProcess if testing Claude integration
6. **Verify**: Run the full check suite:
   ```bash
   pnpm -r typecheck && pnpm -r lint && pnpm -r test
   ```
7. **Commit**: Create a conventional commit:
   ```
   fix(scope): description (closes #$ARGUMENTS)
   ```

If the issue is unclear or requires architectural decisions, explain the options instead of guessing.
