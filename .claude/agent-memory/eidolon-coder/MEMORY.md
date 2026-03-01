# Eidolon Coder Agent Memory

## Project Setup
- Runtime: Bun (not Node.js)
- Package manager: pnpm workspaces
- Monorepo: packages/core, packages/cli, packages/protocol, packages/test-utils

## Key Patterns
- Result pattern for errors: `{ ok: true; value: T } | { ok: false; error: E }`
- Zod schemas at all external boundaries
- IClaudeProcess abstraction for Claude Code CLI interaction
- 3-database split: memory.db, operational.db, audit.db

## Conventions Learned
(Agent will add entries here as it discovers patterns)
