---
name: typecheck
description: Run TypeScript type checking across all Eidolon packages
disable-model-invocation: true
context: fork
agent: eidolon-coder
allowed-tools: Bash(pnpm *), Bash(bun *), Bash(npx *), Read
---

# TypeScript Type Check

Run the TypeScript compiler in check mode across the monorepo.

1. Run `pnpm -r typecheck`
2. Parse output for type errors
3. Group errors by file, showing file:line, error code (TSxxxx), and message
4. For common errors, suggest the fix:
   - TS2322 (type mismatch): show expected vs actual type
   - TS2345 (argument type): show parameter expectation
   - TS7006 (implicit any): suggest explicit type annotation
5. Report total error count per package
