# Eidolon -- AI Assistant Project

Autonomous, self-learning AI daemon using Claude Code CLI as its brain. Replaces OpenClaw.
Public repo: `crack00r/eidolon`. Owner: Manuel Guttmann (German speaker, English code/docs).

## Current Phase

**Phase 0: Foundation** -- first code implementation phase.
See @docs/ROADMAP.md for full plan (~22 weeks, Phases 0-9).

Phase 0 deliverables: pnpm monorepo, TypeScript+Bun, config system (Zod), secret store (AES-256-GCM, Argon2id),
3-database split (memory.db, operational.db, audit.db), CLI skeleton, structured logging, CI pipeline, tests, systemd.

## Tech Stack

- **Core**: TypeScript + Bun (runtime, test runner, bundler)
- **Package manager**: pnpm workspaces
- **Database**: bun:sqlite + sqlite-vec
- **Embeddings**: multilingual-e5-small via @huggingface/transformers (ONNX, 384-dim)
- **GPU worker**: Python/FastAPI (faster-whisper STT, Qwen3-TTS 1.7B)
- **Desktop**: Tauri 2.0
- **iOS**: Swift/SwiftUI
- **Telegram**: grammy
- **Network**: Tailscale mesh VPN + optional Cloudflare Tunnel

## Build & Test Commands

```bash
pnpm install                    # Install all dependencies
pnpm -r build                   # Build all packages
pnpm -r test                    # Run all tests (bun test)
pnpm -r typecheck               # TypeScript type checking
pnpm -r lint                    # ESLint
pnpm -r lint:fix                # ESLint with auto-fix
```

## Monorepo Structure

```
packages/core/       # ~5000-8000 lines -- THE BRAIN (loop, memory, learning, channels, gateway, gpu, security)
packages/cli/        # CLI commands (eidolon daemon start|stop|status, config, secrets, doctor)
packages/protocol/   # Shared types and interfaces
packages/test-utils/ # FakeClaudeProcess, test helpers
apps/desktop/        # Tauri 2.0
apps/ios/            # Swift/SwiftUI
apps/web/            # Web dashboard
services/gpu-worker/ # Python/FastAPI + TTS/STT
```

## CRITICAL: Agent-First Development Workflow

**ALL development work MUST be delegated to subagents. The main session is an ORCHESTRATOR ONLY.**

- **Coding** -> delegate to `eidolon-coder` agent
- **Debugging** -> delegate to `eidolon-debugger` agent
- **Testing** -> delegate to `eidolon-tester` agent
- **Planning/Research** -> delegate to `eidolon-planner` agent (or built-in `Explore`/`Plan`)
- **Code Review** -> delegate to `eidolon-reviewer` agent

The main session MUST NOT: write code directly, debug directly, run tests directly, or do deep research directly.
The main session SHOULD: understand the request, break it into tasks, delegate each to the right agent,
synthesize results, and communicate with the user.

This rule exists because agents preserve main session context, enforce tool restrictions,
enable parallel execution, and produce better results through focused system prompts.

## Critical Architectural Rules

1. **Claude Code CLI is the engine** -- managed subprocess, NOT custom agent runtime
2. **Never use `--dangerously-skip-permissions`** -- use `--allowedTools` whitelisting per session type
3. **IClaudeProcess abstraction** for testability -- FakeClaudeProcess mock for all tests
4. **3-database split** -- memory.db, operational.db, audit.db (eliminates write contention)
5. **Event Bus persisted to SQLite** -- crash recovery for Cognitive Loop
6. **Circuit breakers + graceful degradation** on all external service calls
7. **All code changes from self-learning require user approval**
8. **AES-256-GCM encrypted secrets** with Argon2id key derivation, API keys isolated per subprocess

## Key Design References

Architecture and design details live in these docs (Claude loads on demand):

- @docs/design/ARCHITECTURE.md -- 3-database split, resilience patterns, degradation matrix
- @docs/design/COGNITIVE_LOOP.md -- Perceive-Evaluate-Act-Reflect, backpressure, energy budget
- @docs/design/MEMORY_ENGINE.md -- 5-layer memory, ComplEx KG, RRF hybrid search
- @docs/design/CLAUDE_INTEGRATION.md -- IClaudeProcess, CLI flags, multi-session orchestration
- @docs/design/SECURITY.md -- secrets, GPU auth, GDPR, learning sandbox
- @docs/design/TESTING.md -- test strategy, FakeClaudeProcess, golden datasets, CI
- @docs/design/SELF_LEARNING.md -- discovery, filtering, sandboxed implementation
- @docs/design/GPU_AND_VOICE.md -- Opus codec, faster-whisper, audio preprocessing
- @docs/design/CLIENT_ARCHITECTURE.md -- Tauri, iOS, Cloudflare Tunnel
- @docs/design/CHANNELS.md -- Telegram via grammy
- @docs/reference/CONFIGURATION.md -- config schema, env overrides

## Coding Conventions

- **No `any` types** -- use `unknown` and narrow with type guards
- **Explicit return types** on all exported functions
- **Zod schemas** for all external data (config, API responses, IPC messages)
- **Error handling**: Result pattern (`{ ok, value } | { ok, error }`) for expected failures, throw only for bugs
- **Naming**: camelCase for variables/functions, PascalCase for types/classes, UPPER_SNAKE for constants
- **Imports**: use path aliases (`@eidolon/core`, `@eidolon/protocol`)
- **No default exports** -- use named exports exclusively
- **Prefer `const` over `let`**, never use `var`
- **Max file length**: ~300 lines -- split into modules if exceeding

## Commit Messages

Follow Conventional Commits: `type(scope): description`
Types: feat, fix, refactor, test, docs, chore, ci, perf
Scopes: core, cli, protocol, test-utils, gpu-worker, desktop, ios, web, ci

## Versioning & Releases

- Follow [Semantic Versioning](https://semver.org/): `0.x.y` during development, `1.0.0` at stable release
- **release-please** automates version bumps, CHANGELOG generation, and GitHub Releases from Conventional Commits
- **NEVER edit CHANGELOG.md manually** -- release-please manages it from commit messages
- **NEVER create git tags manually** -- release-please creates release PRs that handle tagging
- Desktop builds (Windows, macOS, Linux via Tauri) and iOS builds trigger automatically on release
- Every release produces: version tag, GitHub Release with notes, platform binaries as assets
- Config: `release-please-config.json` (monorepo packages) + `.release-please-manifest.json` (versions)

## User Context

- **Devices**: Ubuntu server (brain), Windows PC + RTX 5080 (GPU), MacBook (client), iPhone (client)
- **Language**: German conversation, English code and documentation
- **Remote Control**: Use `claude remote-control` for multi-device sessions via Tailscale
