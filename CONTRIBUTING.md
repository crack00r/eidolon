# Contributing to Eidolon

Thank you for your interest in contributing to Eidolon. This document covers the conventions and processes for contributing.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.1
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js >= 20 (for some tooling)
- Git

### Clone and Install

```bash
git clone https://github.com/crack00r/eidolon.git
cd eidolon
bun install
```

### Project Structure

```
packages/core/        # The daemon (brain, memory, loop, learning)
packages/cli/         # CLI tool
packages/protocol/    # Shared types
apps/desktop/         # Tauri desktop client
apps/ios/             # Swift iOS client
services/gpu-worker/  # Python GPU service
docs/                 # Documentation
```

### Running Tests

```bash
# All tests
bun test

# Specific package
bun test --filter core

# Watch mode
bun test --watch
```

### Linting and Formatting

```bash
# Check
bun run lint
bun run format:check

# Fix
bun run lint:fix
bun run format
```

We use [Biome](https://biomejs.dev/) for both linting and formatting. Configuration is in `biome.json`.

## Code Conventions

### TypeScript

- Strict mode enabled (`"strict": true` in tsconfig)
- Prefer `type` imports: `import type { Foo } from './foo'`
- No `any` -- use `unknown` and narrow with type guards
- Prefer `interface` for object shapes, `type` for unions and intersections
- Error handling: return errors as values where practical, throw for unrecoverable failures

### File Organization

- One primary export per file
- Keep files under 300 lines; split when they grow beyond that
- Co-locate tests: `engine.ts` -> `engine.test.ts`
- Index files (`index.ts`) only for public API re-exports

### Naming

| Element | Convention | Example |
|---|---|---|
| Files | kebab-case | `memory-engine.ts` |
| Classes | PascalCase | `MemoryEngine` |
| Functions | camelCase | `extractFacts()` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| Types/Interfaces | PascalCase | `CognitiveState` |
| Database tables | snake_case | `memories`, `audit` |

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`

Scopes: `core`, `cli`, `memory`, `loop`, `learning`, `telegram`, `gpu`, `desktop`, `ios`, `docs`

Examples:
```
feat(memory): add dreaming phase 2 (REM associative discovery)
fix(telegram): handle voice messages larger than 20MB
docs: update ROADMAP with Phase 3 deliverables
refactor(core): extract event bus into separate module
test(memory): add integration tests for hybrid search
```

## Pull Request Process

1. **Fork the repository** and create a feature branch from `main`.
2. **Keep PRs focused.** One feature or fix per PR. If a PR touches more than ~400 lines, consider splitting it.
3. **Include tests** for new functionality.
4. **Update documentation** if behavior changes.
5. **Ensure CI passes** before requesting review.
6. **Write a clear PR description** explaining what changed and why.

### PR Title Format

Same as commit messages: `feat(scope): description`

### Review Criteria

- Does it solve the stated problem?
- Is the code clear and maintainable?
- Are edge cases handled?
- Are there tests?
- Does it follow the project's conventions?
- Is the scope reasonable (not too large)?

## Reporting Issues

### Bug Reports

Include:
- Eidolon version (`eidolon --version`)
- OS and architecture
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output (`~/.eidolon/logs/daemon.log`)

### Feature Requests

Include:
- What problem does this solve?
- Proposed solution (if you have one)
- Alternatives considered
- Is this within Eidolon's scope? (personal AI daemon, not a framework)

## Architecture Decisions

Major architectural changes should be discussed in a GitHub Issue before implementation. Reference the design documents in `docs/design/` for context on existing decisions and their rationale.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
