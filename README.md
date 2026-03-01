# Eidolon

[![CI](https://github.com/crack00r/eidolon/actions/workflows/ci.yml/badge.svg)](https://github.com/crack00r/eidolon/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/crack00r/eidolon?include_prereleases&label=release)](https://github.com/crack00r/eidolon/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.1+-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri&logoColor=white)](https://tauri.app/)

**An autonomous, self-learning personal AI assistant.**

Eidolon is a personal AI daemon that lives on your server, thinks on its own rhythm, learns from the world, and speaks to you wherever you are. It uses Claude as its brain, runs a continuous cognitive loop instead of scheduled cron jobs, consolidates memory through biologically-inspired "dreaming" phases, and can autonomously discover, learn, and implement improvements.

> **Eidolon** (Greek: *eidolon*, "ideal form" or "phantom") -- An autonomous intellect that lives in the background, learns continuously, and evolves over time.

---

## Why Eidolon?

Most personal AI assistants follow the same pattern: wait for input, respond, forget. Even the best ones rely on timers and cron jobs to simulate proactive behavior. Eidolon takes a fundamentally different approach.

| Traditional Assistants | Eidolon |
|---|---|
| Timer wakes agent every 30 min | Continuous cognitive loop with own rhythm |
| "Please write to MEMORY.md" | Automatic memory extraction after every interaction |
| No learning capability | Autonomous discovery, filtering, and implementation |
| Plaintext API keys | AES-256 encrypted secrets with audit trail |
| ElevenLabs cloud TTS ($$$) | Local Qwen3-TTS on your own GPU (free) |
| 430k+ lines of code | ~8k lines, focused and understandable |

## Architecture Overview

```
                         TAILSCALE MESH
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  Ubuntu Server          Windows PC        MacBook    │
  │  ┌──────────────┐      ┌──────────┐    ┌─────────┐  │
  │  │ EIDOLON CORE │      │GPU Worker│    │  Tauri   │  │
  │  │              │◄────►│(Qwen3TTS)│    │  Client  │  │
  │  │ Cognitive    │      │  RTX5080 │    │          │  │
  │  │ Loop         │      └──────────┘    └─────────┘  │
  │  │ Memory       │                                    │
  │  │ Learning     │      iPhone/iPad                   │
  │  │ Claude Code  │      ┌──────────┐                  │
  │  │ Telegram Bot │      │ iOS App  │                  │
  │  └──────────────┘      └──────────┘                  │
  └──────────────────────────────────────────────────────┘
```

**Core** runs on your server (Ubuntu, any Linux, macOS). **Clients** connect from anywhere via Tailscale. **GPU Worker** runs TTS/STT on your Windows machine's GPU. **Telegram** is the primary messaging channel.

## Key Concepts

### Cognitive Loop (not Cron)

Instead of heartbeat timers and cron jobs, Eidolon runs a continuous loop that perceives events, evaluates priorities, acts accordingly, and reflects. It has its own energy budget to prevent unnecessary API costs, adapts its rhythm to time of day and user activity, and uses idle time productively for learning.

### Dreaming Memory

Memory isn't an optional prompt telling the model to write notes. It's an automatic pipeline: every conversation is analyzed, facts and decisions are extracted, and during configurable "dreaming" phases the system consolidates knowledge -- resolving contradictions, finding associations between memories, and abstracting general rules from specific experiences.

### Self-Learning

Eidolon autonomously discovers interesting content from configurable sources (Reddit, Hacker News, GitHub Trending, RSS feeds), evaluates relevance, and can implement improvements to its own codebase via Claude Code -- always in a safe branch, always with the option for user approval.

### Multi-Session Orchestration

Eidolon isn't single-threaded. It manages multiple concurrent sessions -- a user conversation, a background learning crawl, a scheduled task, voice processing -- all at the same time. Sessions communicate with each other through a typed event bus, and a Session Supervisor maintains oversight, manages priorities, and handles resource allocation.

### Claude Code as Engine

Instead of building a custom agent runtime (like most projects do), Eidolon uses **Claude Code CLI** as a managed subprocess. This provides shell execution, filesystem access, web search, and code generation out of the box -- proven and maintained by Anthropic. Eidolon manages the sessions, memory injection, and multi-account failover on top.

## Prerequisites

| Requirement | Version | Purpose |
|---|---|---|
| [Bun](https://bun.sh/) | >= 1.1 | Runtime, test runner, bundler |
| [Node.js](https://nodejs.org/) | >= 22 | pnpm compatibility |
| [pnpm](https://pnpm.io/) | >= 9 | Package manager |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Latest | Execution engine |
| [Rust](https://rustup.rs/) | Stable | Desktop app (Tauri) |
| [Xcode](https://developer.apple.com/xcode/) | >= 16.0 | iOS app (macOS only) |
| [Python](https://www.python.org/) | >= 3.11 | GPU worker (optional) |

## Quick Start

```bash
# Clone the repository
git clone https://github.com/crack00r/eidolon.git
cd eidolon

# Install dependencies
pnpm install

# Run tests
pnpm -r test

# Build all packages
pnpm -r build

# Start the daemon (after Phase 0)
pnpm --filter @eidolon/cli start
```

## Development

```bash
# Install all dependencies
pnpm install

# Lint (Biome)
pnpm -r lint

# Auto-fix lint issues
pnpm -r lint:fix

# Type checking
pnpm -r typecheck

# Run all tests (bun:test)
pnpm -r test

# Build all packages
pnpm -r build
```

### Project Structure

```
packages/core/         # The brain: cognitive loop, memory, learning, channels, security
packages/cli/          # CLI: eidolon daemon start|stop|status, config, secrets, doctor
packages/protocol/     # Shared types and interfaces
packages/test-utils/   # FakeClaudeProcess, test helpers
apps/desktop/          # Tauri 2.0 desktop client (Windows, macOS, Linux)
apps/ios/              # Swift/SwiftUI iOS client
apps/web/              # Web dashboard
services/gpu-worker/   # Python/FastAPI GPU worker (TTS/STT)
```

### Releases

Releases are fully automated via [release-please](https://github.com/googleapis/release-please):

1. **Conventional Commits** on `main` are analyzed automatically
2. **release-please** creates a Release PR with version bump and changelog
3. **Merging the Release PR** creates a GitHub Release with a tag
4. **Platform builds** trigger automatically:
   - **Desktop**: Windows (NSIS + MSI), macOS (DMG, Apple Silicon + Intel), Linux (DEB + AppImage)
   - **iOS**: Archive, IPA export, optional TestFlight upload

All artifacts are attached to the GitHub Release as downloadable assets.

## Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| Core Daemon | TypeScript / Bun | Cross-platform, fast, native SQLite |
| Execution Engine | Claude Code CLI | Proven agent runtime, OAuth support |
| Database | SQLite (bun:sqlite) | Embedded, zero-config, single file |
| Vector Search | sqlite-vec | Semantic search without external service |
| Desktop Apps | Tauri 2.0 | ~5MB binaries, native system access |
| iOS App | Swift / SwiftUI | Native performance and OS integration |
| GPU Service | Python / FastAPI | Qwen3-TTS runs natively in Python |
| Telegram | grammY | Battle-tested Telegram bot framework |
| Browser | Playwright | Cross-browser automation |
| Networking | Tailscale | Zero-config mesh VPN |
| CI/CD | GitHub Actions | Release-please, multi-platform builds |

## Documentation

| Document | Description |
|---|---|
| [Vision](docs/VISION.md) | Philosophy, principles, and project goals |
| [Architecture](docs/design/ARCHITECTURE.md) | Full technical architecture |
| [Cognitive Loop](docs/design/COGNITIVE_LOOP.md) | The continuous thinking process |
| [Memory Engine](docs/design/MEMORY_ENGINE.md) | Dreaming-based memory system |
| [Self-Learning](docs/design/SELF_LEARNING.md) | Autonomous learning pipeline |
| [Claude Integration](docs/design/CLAUDE_INTEGRATION.md) | Claude Code as execution engine |
| [Security](docs/design/SECURITY.md) | Security model and threat analysis |
| [GPU & Voice](docs/design/GPU_AND_VOICE.md) | TTS/STT with GPU offloading |
| [Clients](docs/design/CLIENT_ARCHITECTURE.md) | Desktop, iOS, and web clients |
| [Channels](docs/design/CHANNELS.md) | Telegram and future channel support |
| [Testing](docs/design/TESTING.md) | Testing strategy and CI pipeline |
| [Accessibility](docs/design/ACCESSIBILITY.md) | WCAG 2.1 AA compliance plan |
| [Home Automation](docs/design/HOME_AUTOMATION.md) | Home Assistant integration |
| [Configuration](docs/reference/CONFIGURATION.md) | Full configuration reference |
| [Roadmap](docs/ROADMAP.md) | Development phases and milestones |
| [Review Findings](docs/REVIEW_FINDINGS.md) | Consolidated findings from 20 expert reviews |
| [Comparison](docs/COMPARISON.md) | Detailed OpenClaw vs Eidolon analysis |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines, coding conventions, and the contribution workflow.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy.

## License

[MIT](LICENSE)
