# Eidolon -- Project Context for AI Assistants

This file provides full context for Claude Code and any AI coding assistant working on this project.

## Goal

Build **Eidolon** -- a new personal AI assistant that replaces OpenClaw (currently running on an Ubuntu notebook). The project is a public GitHub repo under `crack00r/eidolon`. The core concept: an autonomous, self-learning AI daemon that uses Claude/Claude Code as its brain, runs a continuous "Cognitive Loop" instead of cron jobs, has biologically-inspired "dreaming" memory consolidation, can autonomously discover and implement improvements, and supports multi-device interaction (Ubuntu server as brain, Windows PC with RTX 5080 for GPU/TTS, MacBook client, iPhone client, Telegram).

## Current Phase

**Planning & Documentation is COMPLETE. Expert reviews integrated. Ready for Phase 0: Foundation (code implementation).**

See `docs/ROADMAP.md` for the full development roadmap. Phase 0 deliverables:
- pnpm workspace with `packages/core`, `packages/cli`, `packages/protocol`
- TypeScript + Bun configuration
- Compatibility verification: `bun:sqlite` + `sqlite-vec`, `@huggingface/transformers` on Bun
- Config system (Zod validation, env overrides)
- Secret store (AES-256-GCM, Argon2id)
- 3-database split: `memory.db`, `operational.db`, `audit.db` with migration system
- CLI skeleton (`eidolon daemon start|stop|status`, `eidolon config`, `eidolon secrets`, `eidolon doctor`)
- Structured logging
- CI pipeline (GitHub Actions: lint, typecheck, test)
- Test infrastructure with `bun test`
- systemd service file
- Automated daily backup

## Instructions

- The project is structured for a **public GitHub repo** -- clean docs, no private data, enterprise-level documentation.
- Use **Claude Code CLI as the execution engine** (managed subprocess), not a custom agent runtime. This is the key architectural insight.
- **Never use `--dangerously-skip-permissions`**. Use `--allowedTools` whitelisting per session type instead.
- **Multi-account auth** with failover: multiple OAuth accounts (Anthropic Max subscription) + multiple API keys, with automatic rotation when one hits rate limits.
- **Tech stack**: TypeScript/Bun for core, Python/FastAPI for GPU worker, Tauri 2.0 for desktop apps, Swift for iOS, grammY for Telegram.
- All devices connected via **Tailscale** (already working in user's setup). Optional Cloudflare Tunnel for mobile without VPN.
- Target **~8,000 lines of own code** (aspirational; actual may be 10-12k). Tests not counted.

## Key Architectural Decisions

1. **Claude Code CLI as engine** eliminates ~80% of code. Key flags: `-p`, `--output-format stream-json`, `--resume`, `--session-id`, `--worktree`, `--max-budget-usd`, `--fallback-model`, `--append-system-prompt`, `--agents`, `--mcp-config`, `--allowedTools`.
2. **IClaudeProcess abstraction** layer for testability. `FakeClaudeProcess` mock for tests.
3. **Cognitive Loop** (Perceive-Evaluate-Act-Reflect) replaces cron/heartbeat. Event-driven, priority-based, energy-budget-aware. Circuit breakers, backpressure, retry logic.
4. **Multi-Session Orchestration**: Session Supervisor manages concurrent sessions. Max 3 concurrent Claude Code processes. Event Bus persisted to SQLite.
5. **Automatic memory extraction** after every conversation. 5-layer memory with dreaming consolidation.
6. **Local embeddings**: `multilingual-e5-small` via `@huggingface/transformers` (ONNX, 384-dim, proper German support).
7. **Knowledge Graph with ComplEx embeddings** (not TransE): handles symmetric, 1-N, and reflexive relations. Leiden community detection. PageRank. All in SQLite.
8. **Hybrid search with RRF fusion**: BM25 + vector search fused via Reciprocal Rank Fusion.
9. **Self-learning pipeline**: all code changes require user approval. Content sanitized before LLM evaluation. Evaluation uses restricted tools.
10. **"Her"-style real-time voice**: Opus codec (not raw PCM), `Intl.Segmenter` for sentence detection, audio preprocessing (high-pass + AGC + noise suppression), WebRTC AEC3, jitter buffer. Realistic median latency ~1200-1500ms.
11. **STT: faster-whisper** (same quality as Whisper, 4x faster, half VRAM). **TTS: Qwen3-TTS 1.7B** on RTX 5080. Kitten TTS CPU fallback.
12. **3-database split**: `memory.db`, `operational.db`, `audit.db` to eliminate write contention.
13. **AES-256-GCM encrypted secrets** with Argon2id key derivation. API keys isolated per subprocess.
14. **GPU worker authentication**: pre-shared key on all endpoints.
15. **Circuit breakers + graceful degradation** for all external services.
16. **GDPR compliance**: `eidolon privacy forget`, `eidolon privacy export`, voice consent, third-party PII flagging.
17. **Testing from Phase 0**: CI pipeline, `FakeClaudeProcess`, golden datasets for memory extraction evaluation.

## Documentation Structure

```
eidolon/
├── README.md
├── LICENSE                                # MIT
├── CONTRIBUTING.md
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md                     # Contributor Covenant v2.1
├── SECURITY.md                            # Vulnerability reporting policy
├── CLAUDE.md                              # THIS FILE
├── docs/
│   ├── VISION.md
│   ├── ROADMAP.md                         # Phase 0-9 (~22 weeks)
│   ├── COMPARISON.md
│   ├── REVIEW_FINDINGS.md                 # Consolidated findings from 20 expert reviews
│   ├── design/
│   │   ├── ARCHITECTURE.md                # 3-database split, resilience patterns
│   │   ├── COGNITIVE_LOOP.md              # Loop, backpressure, circuit breakers
│   │   ├── MEMORY_ENGINE.md               # 5-layer memory, ComplEx KG, RRF search
│   │   ├── SELF_LEARNING.md               # Discovery, filtering, sandboxed implementation
│   │   ├── CLAUDE_INTEGRATION.md          # IClaudeProcess abstraction, CLI flags
│   │   ├── SECURITY.md                    # Secrets, GPU auth, GDPR, learning sandbox
│   │   ├── GPU_AND_VOICE.md               # Opus, faster-whisper, audio preprocessing
│   │   ├── CLIENT_ARCHITECTURE.md         # Tauri, iOS (6 weeks), Cloudflare Tunnel
│   │   ├── CHANNELS.md                    # Telegram
│   │   ├── TESTING.md                     # Test strategy, FakeClaudeProcess, CI
│   │   ├── ACCESSIBILITY.md               # WCAG 2.1 AA, voice-first a11y
│   │   └── HOME_AUTOMATION.md             # HA via MCP, security policies
│   └── reference/
│       └── CONFIGURATION.md
├── .github/
│   ├── workflows/                         # CI pipeline
│   ├── ISSUE_TEMPLATE/                    # Bug report, feature request
│   └── PULL_REQUEST_TEMPLATE.md
```

## Monorepo Structure (Target -- not yet created)

```
eidolon/
├── packages/
│   ├── core/                    # ~5000-8000 lines - THE BRAIN
│   │   ├── src/
│   │   │   ├── index.ts         # Daemon entry
│   │   │   ├── loop.ts          # Cognitive Loop
│   │   │   ├── brain.ts         # Claude Code Manager (IClaudeProcess)
│   │   │   ├── events.ts        # Event Bus (persisted)
│   │   │   ├── memory/          # Memory engine, extractor, dreaming, KG (ComplEx), search (RRF)
│   │   │   ├── learning/        # Self-learning, discovery, classifier
│   │   │   ├── channels/        # Telegram (grammY), channel interface
│   │   │   ├── gateway/         # WebSocket server, JSON-RPC, REST API
│   │   │   ├── gpu/             # GPU worker communication, TTS/STT client, voice pipeline
│   │   │   ├── security/        # Secrets, policies, audit
│   │   │   ├── resilience/      # Circuit breakers, retry, backpressure
│   │   │   └── config.ts        # Config schema + loader
│   │   └── test/                # Tests mirroring src/
│   ├── cli/                     # CLI commands
│   ├── protocol/                # Shared types
│   └── test-utils/              # FakeClaudeProcess, test helpers
├── apps/
│   ├── desktop/                 # Tauri 2.0
│   ├── ios/                     # Swift/SwiftUI (6 weeks, not 2)
│   └── web/                     # Web dashboard
├── services/
│   └── gpu-worker/              # Python/FastAPI + Qwen3-TTS + faster-whisper
├── workspace/                   # Template workspace files
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
