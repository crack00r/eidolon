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

1. **Claude Code CLI as engine** eliminates ~80% of code that OpenClaw needs for its custom agent runtime. Shell, filesystem, web search, code generation all come free. Key flags: `-p`, `--output-format stream-json`, `--resume`, `--session-id`, `--worktree`, `--max-budget-usd`, `--fallback-model`, `--append-system-prompt`, `--agents`, `--mcp-config`, `--allowedTools`.
2. **Cognitive Loop** (Perceive-Evaluate-Act-Reflect) replaces cron/heartbeat. Event-driven, priority-based, energy-budget-aware.
3. **Multi-Session Orchestration**: Session Supervisor manages concurrent sessions (user chat, learning, tasks, voice, dreaming) with inter-session communication via Event Bus. Sessions can coordinate, share discoveries, and hand off work. Max 3 concurrent Claude Code processes.
4. **Automatic memory extraction** after every conversation (not model-dependent). 5-layer memory (working, short-term, long-term, episodic, procedural) with dreaming consolidation (Housekeeping, REM, NREM).
5. **Local embeddings by default**: `all-MiniLM-L6-v2` via `@huggingface/transformers` (ONNX, 384-dim, ~23MB, no API dependency). Optional: Voyage AI or OpenAI for higher quality.
6. **Knowledge Graph with TransE embeddings**: Store knowledge as (Subject, Predicate, Object) triples in `kg_entities`/`kg_relations`/`kg_communities` tables. TransE for link prediction during REM dreaming. Leiden algorithm for community detection during NREM. PageRank for entity importance. Graph-enhanced search injects structured triples into MEMORY.md. All runs in SQLite, no external graph DB.
7. **Self-learning pipeline**: discover content from Reddit/HN/GitHub, evaluate relevance, implement improvements via Claude Code in isolated git worktrees. Auto-lint/test after code changes. Skill extraction from repeated patterns.
8. **"Her"-style real-time voice**: Full-duplex streaming voice with sentence-level TTS chunking (~900ms target latency), VAD-based endpointing, barge-in/interruption support, echo cancellation. WebSocket protocol with binary+JSON messages and explicit state machine (idle/listening/processing/speaking/interrupted).
9. **Qwen3-TTS 1.7B** on RTX 5080 for local voice (free, ~97ms latency, 10 languages). Kitten TTS (~25MB, CPU-only) as fallback.
10. **SQLite** for all persistent state (bun:sqlite native, sqlite-vec for vectors, FTS5 for full-text).
11. **AES-256-GCM encrypted secrets** with Argon2id key derivation. No plaintext API keys.
12. **OpenAI-compatible REST API** on the gateway for tool/client interoperability.
13. **MCP server support** for extensibility -- forward configured MCP servers to Claude Code via `--mcp-config`.
14. **Token/cost tracking** per session from day one, with model pricing table and energy budget enforcement.
15. **Sub-agent routing**: cheap models (Haiku) for classification/extraction, expensive models (Opus/Sonnet) for code generation and reasoning.
16. **Process pool / pre-warming** for Claude Code processes to avoid ~2s startup penalty.
17. **Research mode** (`/research` command): deep-dive into a topic using multiple sources, synthesize findings.

## Discoveries from Research

### OpenClaw Analysis
- **Core weaknesses**: Heartbeat (30min timer) + Cron is not true autonomy; memory relies on model voluntarily writing to MEMORY.md; no self-learning; 430k+ lines of bloated code; 223 security advisories; plaintext API keys; Google account bans from OAuth.
- **Stabilization mode**: drowning in PRs, closing feature requests. Major opportunity for focused alternative.
- **Most requested features**: IDE independence, multi-key rotation (39-66 votes), RAG/persistent memory (38-56 votes), headless/remote operation (28-37 votes).
- **Biggest bugs**: file editing unreliable, JetBrains broken, terminal integration fails, regressions with every release.
- **No voice/TTS features at all** -- completely unaddressed space.

### Competing Projects Analyzed
- **Plandex** (15k stars): Sandboxed diff review, plan versioning with branches
- **Aider** (41k): Repository mapping via tree-sitter, voice-to-code, auto-lint/test, 88% self-written
- **OpenHands** (68k): Docker sandboxing, composable agent SDK, multi-interface
- **Browser-Use** (79k): Dedicated browser automation for self-learning
- **Dify** (131k): LLMOps observability, RAG pipeline, human-in-the-loop
- **Mem0** (48k): Graph memory with relationships, 4-layer memory with promotion pipeline
- **Letta/MemGPT** (21k): Stateful agents, self-modifying memory
- **Khoj** (32k): Document indexing, multi-interface, /research mode
- **Jan** (40k): Validates Tauri 2.0 stack, OpenAI-compatible REST API pattern
- **Continue** (31k): Markdown-as-agent-definition, git worktrees, pivoted to CLI-first
- **Roo Code** (22.5k): Modes system validates multi-session concept

### Community Sentiment (Reddit, HN)
- #1 wish: "AI that actually remembers what I told it last week"
- Strong demand for ambient/non-screen voice interaction ("Her"-style)
- Self-hosting is non-negotiable for the target audience
- Home Assistant integration is the killer app people want
- Kitten TTS (25MB, CPU-only, 14M params) discovered as edge-device TTS fallback

### Features Added Based on Research
1. OpenAI-compatible REST API on gateway
2. Token/cost tracking per session from day one
3. MCP server support for extensibility
4. Sub-agent routing (cheap models for classification, expensive for code)
5. Knowledge Graph with TransE embeddings
6. Document indexing (personal files, not just conversations)
7. Kitten TTS as CPU fallback
8. Auto-lint/test after code changes
9. Process pool / pre-warming for Claude Code
10. Skill extraction from repeated patterns
11. Research mode (/research command)

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
│   ├── ROADMAP.md                         # Phase 0-9 development plan (~15 weeks)
│   ├── COMPARISON.md                      # Detailed OpenClaw vs Eidolon analysis
│   ├── design/
│   │   ├── ARCHITECTURE.md                # Full system architecture, SQLite schema, monorepo
│   │   ├── COGNITIVE_LOOP.md              # Perceive-Evaluate-Act-Reflect, multi-session, sub-agents
│   │   ├── MEMORY_ENGINE.md               # 5-layer memory, dreaming, Knowledge Graph (TransE)
│   │   ├── SELF_LEARNING.md               # Discovery, filtering, skill extraction, research mode
│   │   ├── CLAUDE_INTEGRATION.md          # Claude Code CLI as engine, multi-account rotation
│   │   ├── SECURITY.md                    # Encrypted secrets, action policies, audit trail
│   │   ├── GPU_AND_VOICE.md               # GPU worker, TTS/STT, real-time voice protocol
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
│   │       ├── memory/          # Memory engine, extractor, dreaming, knowledge graph, search
│   │       ├── learning/        # Self-learning, discovery, classifier
│   │       ├── channels/        # Telegram (grammY), channel interface
│   │       ├── gateway/         # WebSocket server, JSON-RPC, REST API
│   │       ├── gpu/             # GPU worker communication, TTS/STT client, voice pipeline
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
