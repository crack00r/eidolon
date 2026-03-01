---
name: test
description: Run tests for Eidolon packages using bun test
disable-model-invocation: true
allowed-tools: Bash(pnpm *), Bash(bun *), Read
---

# Run Tests

Run the test suite and report results clearly.

1. Run `pnpm -r test` (all packages) or `pnpm --filter $ARGUMENTS test` (specific package)
2. Parse the output for passed, failed, and skipped counts
3. For failures, show:
   - Test name and file:line
   - Expected vs actual values
   - Suggested fix if obvious
4. Summarize: total passed, failed, skipped, duration

If no arguments given, run all tests. If a file path is given, run only that file:
```bash
bun test $ARGUMENTS
```
