# Eidolon

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
| [Configuration](docs/reference/CONFIGURATION.md) | Full configuration reference |
| [Roadmap](docs/ROADMAP.md) | Development phases and milestones |
| [Comparison](docs/COMPARISON.md) | Detailed OpenClaw vs Eidolon analysis |
| [Contributing](CONTRIBUTING.md) | How to contribute |

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

## Project Status

**Phase: Planning & Design**

Eidolon is currently in the design phase. All architecture documents are being written and refined before any code is committed. See the [Roadmap](docs/ROADMAP.md) for the planned development phases.

## License

[MIT](LICENSE)
