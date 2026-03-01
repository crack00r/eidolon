---
name: lint
description: Run linting across all Eidolon packages and optionally auto-fix
disable-model-invocation: true
context: fork
agent: eidolon-coder
allowed-tools: Bash(pnpm *), Bash(bun *), Bash(npx *), Read
---

# Lint Eidolon

Run ESLint across the monorepo and report issues.

1. Run `pnpm -r lint`
2. Parse output for errors vs warnings
3. Group issues by file, showing file:line and rule name
4. Report total error and warning counts

To auto-fix:
```bash
pnpm -r lint:fix
```

If `$ARGUMENTS` contains "fix" or "auto-fix", run lint:fix instead of lint.
