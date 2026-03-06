# Eidolon

[![CI](https://github.com/crack00r/eidolon/actions/workflows/ci.yml/badge.svg)](https://github.com/crack00r/eidolon/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/crack00r/eidolon?include_prereleases&label=release)](https://github.com/crack00r/eidolon/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.1+-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![Tests](https://img.shields.io/badge/tests-1888%20passing-brightgreen)]()
[![Security Audit](https://img.shields.io/badge/security%20audit-93%2F93%20fixed-brightgreen)]()

**Autonomous, self-learning AI assistant daemon powered by Claude Code CLI.**

Eidolon is a personal AI daemon that runs on your server, thinks on its own rhythm, and learns continuously. Instead of the traditional request-response pattern, it operates a continuous cognitive loop, consolidates memory through biologically-inspired "dreaming" phases, and autonomously discovers, validates, and implements improvements to itself.

> **Eidolon** (Greek: *eidolon*, "ideal form") -- An autonomous intellect that lives in the background, learns continuously, and evolves over time.

---

## Features

- **Cognitive Loop** -- Continuous Perceive-Evaluate-Act-Reflect cycle with adaptive energy budgeting (not cron jobs)
- **5-Layer Memory** -- Working, episodic, semantic, procedural, and meta-cognitive memory with dreaming-based consolidation
- **Knowledge Graph** -- ComplEx embeddings over a typed knowledge graph for relational reasoning
- **Self-Learning** -- Autonomous discovery from configurable sources, safety validation, sandboxed implementation with user approval
- **Multi-Session Orchestration** -- Concurrent user conversations, background tasks, learning crawls, and voice processing
- **Voice** -- Local TTS (Qwen3-TTS 1.7B) and STT (faster-whisper) on your own GPU, no cloud APIs needed
- **Multi-Device** -- Tailscale mesh VPN connects server, desktop, mobile, and GPU worker seamlessly
- **Gateway** -- WebSocket JSON-RPC with TLS, rate limiting, and token-based authentication
- **Clients** -- Tauri 2.0 desktop, SwiftUI iOS, SvelteKit web dashboard, Telegram bot (grammy)
- **Claude Code as Engine** -- Managed subprocess, not a custom agent runtime; proven CLI maintained by Anthropic

## Architecture

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

**Core** runs on your server. **Clients** connect from anywhere via Tailscale. **GPU Worker** handles TTS/STT on a dedicated GPU machine. **Telegram** serves as the primary messaging channel.

## Project Structure

```
packages/core/         # The brain: cognitive loop, memory, learning, channels, gateway, security
packages/cli/          # CLI: eidolon daemon start|stop|status, config, secrets, doctor, onboard
packages/protocol/     # Shared types and Zod schemas
packages/test-utils/   # FakeClaudeProcess and test helpers
apps/desktop/          # Tauri 2.0 + Svelte 5 (Windows, macOS, Linux)
apps/ios/              # Swift/SwiftUI iOS client
apps/web/              # SvelteKit web dashboard
services/gpu-worker/   # Python/FastAPI GPU service (TTS/STT)
```

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | TypeScript + Bun |
| Package Manager | pnpm workspaces |
| Database | bun:sqlite (3-database split: memory, operational, audit) |
| Vector Search | sqlite-vec (multilingual-e5-small, ONNX, 384-dim) |
| Execution Engine | Claude Code CLI (managed subprocess) |
| Desktop | Tauri 2.0 + Svelte 5 |
| iOS | Swift / SwiftUI |
| Web | SvelteKit |
| GPU Service | Python / FastAPI (Qwen3-TTS 1.7B, faster-whisper) |
| Telegram | grammy |
| Networking | Tailscale mesh VPN + optional Cloudflare Tunnel |
| CI/CD | GitHub Actions + release-please |

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| [Bun](https://bun.sh/) | >= 1.1 | Runtime, test runner, bundler |
| [Node.js](https://nodejs.org/) | >= 22 | pnpm compatibility |
| [pnpm](https://pnpm.io/) | >= 9 | Package manager |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | Latest | Execution engine |
| [Rust](https://rustup.rs/) | Stable | Desktop app (Tauri), optional |
| [Python](https://www.python.org/) | >= 3.11 | GPU worker, optional |

### Setup

```bash
git clone https://github.com/crack00r/eidolon.git
cd eidolon
pnpm install
pnpm -r build
pnpm -r test          # 1888 tests passing
```

## Development

```bash
pnpm install          # Install all dependencies
pnpm -r build         # Build all packages
pnpm -r test          # Run tests (Bun test runner)
pnpm -r typecheck     # TypeScript type checking
pnpm -r lint          # Biome linter
pnpm -r lint:fix      # Auto-fix lint issues
```

### Releases

Releases are automated via [release-please](https://github.com/googleapis/release-please). Conventional Commits on `main` trigger version bumps, changelog generation, and GitHub Releases. Platform builds (Windows, macOS, Linux via Tauri; iOS archive) are produced automatically and attached as release assets.

## Security

A comprehensive security audit identified **93 findings** across all severity levels -- all have been fixed:

| Severity | Count | Status |
|---|---|---|
| Critical | 4 | Fixed |
| High | 16 | Fixed |
| Medium | 44 | Fixed |
| Low | 29 | Fixed |

Key security measures:

- **Secret store**: AES-256-GCM encryption with scrypt key derivation
- **Transport**: TLS on all gateway connections
- **Authentication**: Constant-time token comparison, rate limiting with exponential backoff
- **Input validation**: Protection against FTS5 injection, SQL injection, path traversal, command injection
- **Privacy**: GDPR commands (data export, deletion, anonymization), IP anonymization in logs
- **Deployment**: Systemd hardening, non-root Docker containers

For vulnerability reporting, see [SECURITY.md](SECURITY.md).

## Documentation

| Document | Description |
|---|---|
| [Architecture](docs/design/ARCHITECTURE.md) | 3-database split, resilience patterns, degradation matrix |
| [Cognitive Loop](docs/design/COGNITIVE_LOOP.md) | Perceive-Evaluate-Act-Reflect cycle |
| [Memory Engine](docs/design/MEMORY_ENGINE.md) | 5-layer memory, ComplEx KG, hybrid search |
| [Self-Learning](docs/design/SELF_LEARNING.md) | Autonomous discovery and implementation pipeline |
| [Claude Integration](docs/design/CLAUDE_INTEGRATION.md) | Claude Code CLI as managed subprocess |
| [Security](docs/design/SECURITY.md) | Threat model and security architecture |
| [GPU and Voice](docs/design/GPU_AND_VOICE.md) | TTS/STT with local GPU offloading |
| [Clients](docs/design/CLIENT_ARCHITECTURE.md) | Desktop, iOS, and web client architecture |
| [Channels](docs/design/CHANNELS.md) | Telegram and messaging channels |
| [Testing](docs/design/TESTING.md) | Test strategy and CI pipeline |
| [Configuration](docs/reference/CONFIGURATION.md) | Full configuration reference |
| [Roadmap](docs/ROADMAP.md) | Development phases and milestones |

## Project Status

All 10 development phases (0-9) are complete. The project is in pre-release (`0.x.y`), targeting `1.0.0` for stable release. See the [Roadmap](docs/ROADMAP.md) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and coding conventions.

## License

[MIT](LICENSE)
