# Eidolon -- Project Context for AI Assistants

This file provides full context for Claude Code, Claude Code, and any AI coding assistant working on this project.

## Goal

Build **Eidolon** -- a new personal AI assistant that replaces OpenClaw (currently running on an Ubuntu notebook). The project is a public GitHub repo under `crack00r/eidolon`. The core concept: an autonomous, self-learning AI daemon that uses Claude/Claude Code as its brain, runs a continuous "Cognitive Loop" instead of cron jobs, has biologically-inspired "dreaming" memory consolidation, can autonomously discover and implement improvements, and supports multi-device interaction (Ubuntu server as brain, Windows PC with RTX 5080 for GPU/TTS, MacBook client, iPhone client, Telegram).

## Current Phase

**Planning & Documentation is COMPLETE. Ready for Phase 0: Foundation (code implementation).**

See `docs/ROADMAP.md` for the full development roadmap. Phase 0 deliverables:
- pnpm workspace with `packages/core`, `packages/cli`, `packages/protocol`
- TypeScript + Bun configuration
- Config system (Zod validation, env overrides)
- Secret store (AES-256-GCM, Argon2id)
- SQLite database with migration system
- CLI skeleton (`eidolon start`, `eidolon config`, `eidolon secrets`, `eidolon doctor`)
- Structured logging

## Instructions

- The project is structured for a **public GitHub repo** -- clean docs, no private data, enterprise-level documentation.
- Use **Claude Code CLI as the execution engine** (managed subprocess), not a custom agent runtime. This is the key architectural insight.
- **Multi-account auth** with failover: multiple OAuth accounts (Anthropic Max subscription) + multiple API keys, with automatic rotation when one hits rate limits.
- **Tech stack**: TypeScript/Bun for core, Python/FastAPI for GPU worker, Tauri 2.0 for desktop apps, Swift for iOS, grammY for Telegram.
- All devices connected via **Tailscale** (already working in user's setup).
- Target **~8,000 lines of own code** total. Stay focused, stay small.

## Key Architectural Decisions

1. **Claude Code CLI as engine** eliminates ~80% of code that OpenClaw needs for its custom agent runtime. Shell, filesystem, web search, code generation all come free. Key flags: `-p`, `--output-format stream-json`, `--resume`, `--session-id`, `--worktree`, `--max-budget-usd`, `--fallback-model`, `--append-system-prompt`, `--agents`.
2. **Cognitive Loop** (Perceive-Evaluate-Act-Reflect) replaces cron/heartbeat. Event-driven, priority-based, energy-budget-aware.
3. **Multi-Session Orchestration**: Session Supervisor manages concurrent sessions (user chat, learning, tasks, voice, dreaming) with inter-session communication via Event Bus. Sessions can coordinate, share discoveries, and hand off work. Max 3 concurrent Claude Code processes.
4. **Automatic memory extraction** after every conversation (not model-dependent). 5-layer memory (working, short-term, long-term, episodic, procedural) with dreaming consolidation (Housekeeping, REM, NREM).
5. **Local embeddings by default**: `all-MiniLM-L6-v2` via `@huggingface/transformers` (ONNX, 384-dim, ~23MB, no API dependency). Optional: Voyage AI or OpenAI for higher quality.
6. **Self-learning pipeline**: discover content from Reddit/HN/GitHub, evaluate relevance, implement improvements via Claude Code in isolated git worktrees.
7. **SQLite** for all persistent state (bun:sqlite native, sqlite-vec for vectors, FTS5 for full-text).
8. **AES-256-GCM encrypted secrets** with Argon2id key derivation. No plaintext API keys.
9. **Qwen3-TTS 1.7B** on RTX 5080 for local voice (free, ~97ms latency, 10 languages).

## Discoveries from Research

- **OpenClaw's core weaknesses**: Heartbeat (30min timer) + Cron is not true autonomy; memory relies on model voluntarily writing to MEMORY.md; no self-learning; 430k+ lines of bloated code; 223 security advisories; plaintext API keys; Google account bans from OAuth.
- **OpenClaw is in "stabilization mode"** -- drowning in PRs, closing feature requests. Major opportunity for focused alternative.
- **Key competing projects analyzed**: nanobot (Python, ultra-lightweight, 4k lines), nanoclaw (TypeScript, container isolation), agenticSeek (fully local), SafePilot (Rust, security-obsessed), Wintermute (biologically-inspired dreaming), Kai (wraps Claude Code CLI).
- **Qwen3-TTS 1.7B in bfloat16** needs ~3.4GB VRAM -- fits easily on RTX 5080 (16GB). Streaming latency ~97ms. 10 languages including German.

## Documentation Structure (ALL COMPLETE)

```
eidolon/
├── README.md                              # Project overview, architecture diagram, tech stack
├── LICENSE                                # MIT
├── CONTRIBUTING.md                        # Dev setup, conventions, PR process
├── CHANGELOG.md                           # Keep a Changelog format
├── CLAUDE.md                              # THIS FILE -- AI assistant context
├── docs/
│   ├── VISION.md                          # Philosophy, design principles, target user
│   ├── ROADMAP.md                         # Phase 0-9 development plan (~14 weeks)
│   ├── COMPARISON.md                      # Detailed OpenClaw vs Eidolon analysis
│   ├── design/
│   │   ├── ARCHITECTURE.md                # Full system architecture, SQLite schema, monorepo structure
│   │   ├── COGNITIVE_LOOP.md              # Perceive-Evaluate-Act-Reflect loop, energy budget
│   │   ├── MEMORY_ENGINE.md               # 5-layer memory, auto-extractor, dreaming (3 phases)
│   │   ├── SELF_LEARNING.md               # Discovery pipeline, safety classification
│   │   ├── CLAUDE_INTEGRATION.md          # Claude Code CLI as engine, multi-account rotation
│   │   ├── SECURITY.md                    # Encrypted secrets, action policies, audit trail
│   │   ├── GPU_AND_VOICE.md               # GPU worker, Qwen3-TTS, Docker deployment
│   │   ├── CLIENT_ARCHITECTURE.md         # Tauri desktop, iOS app, web dashboard
│   │   └── CHANNELS.md                    # Telegram implementation, channel interface
│   └── reference/
│       └── CONFIGURATION.md               # Full eidolon.json schema with all options
```

## Monorepo Structure (Target -- not yet created)

```
eidolon/
├── packages/
│   ├── core/                    # ~5000-8000 lines - THE BRAIN
│   │   └── src/
│   │       ├── index.ts         # Daemon entry
│   │       ├── loop.ts          # Cognitive Loop
│   │       ├── brain.ts         # Claude Code Manager
│   │       ├── events.ts        # Event Bus
│   │       ├── memory/          # Memory engine, extractor, dreaming, search
│   │       ├── learning/        # Self-learning, discovery, classifier
│   │       ├── channels/        # Telegram (grammY), channel interface
│   │       ├── gateway/         # WebSocket server, JSON-RPC
│   │       ├── gpu/             # GPU worker communication, TTS client
│   │       ├── security/        # Secrets, policies, audit
│   │       └── config.ts        # Config schema + loader
│   ├── cli/                     # CLI commands
│   └── protocol/                # Shared types
├── apps/
│   ├── desktop/                 # Tauri 2.0
│   ├── ios/                     # Swift/SwiftUI
│   └── web/                     # Web dashboard
├── services/
│   └── gpu-worker/              # Python/FastAPI + Qwen3-TTS
├── workspace/                   # Template workspace files (SOUL.md, CLAUDE.md, skills/)
└── docs/                        # Documentation (complete)
```

## User Context

- **Owner**: Manuel Guttmann
- **GitHub**: crack00r
- **Devices**: Ubuntu server (brain), Windows PC with RTX 5080 (GPU), MacBook (client), iPhone (client)
- **Network**: Tailscale mesh VPN (already configured and working)
- **Current setup**: OpenClaw on Ubuntu notebook (to be replaced by Eidolon)
- **Language preference**: German for conversation, English for code and documentation

## Related Directories

- `/Users/manuelguttmann/Projekte/eidolon/` -- This project
- `/Users/manuelguttmann/Projekte/OpenClaw/` -- User's OpenClaw installation (reference, will be decommissioned)
