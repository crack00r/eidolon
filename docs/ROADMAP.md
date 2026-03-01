# Roadmap

Development is organized into phases. Each phase produces a working system that builds on the previous one. No phase begins until the prior phase is stable and tested.

## Overview

```
Phase 0: Foundation          (~2 weeks)    Monorepo, config, secrets, database
Phase 1: Brain               (~2 weeks)    Claude Code integration, single conversation
Phase 2: Memory              (~2 weeks)    Auto-extraction, search, dreaming
Phase 3: Cognitive Loop       (~2 weeks)    Event bus, loop, multi-session, energy budget
Phase 4: Telegram             (~1 week)     Telegram bot, message routing
Phase 5: Self-Learning        (~2 weeks)    Discovery, filtering, implementation pipeline
Phase 6: Voice                (~1 week)     GPU worker, Qwen3-TTS, STT
Phase 7: Desktop Client       (~2 weeks)    Tauri app for macOS/Windows/Linux
Phase 8: iOS Client           (~2 weeks)    Swift app for iPhone/iPad
Phase 9: Polish & Release     (~1 week)     CI/CD, docs, GitHub release
```

**Estimated total:** ~15 weeks for a complete v1.0 release.

---

## Phase 0: Foundation

**Goal:** A working monorepo with config loading, encrypted secrets, SQLite database, and CLI skeleton.

**Deliverables:**
- [ ] pnpm workspace with `packages/core`, `packages/cli`, `packages/protocol`
- [ ] TypeScript + Bun configuration (tsconfig, biome for linting/formatting)
- [ ] Config system: load `eidolon.json`, validate with Zod, env variable overrides
- [ ] Secret store: AES-256-GCM encryption, Argon2id key derivation, CLI commands
- [ ] SQLite database: schema migration system, initial tables (memories, sessions, audit, discoveries, state, token_usage)
- [ ] CLI skeleton: `eidolon daemon start|stop|status`, `eidolon config`, `eidolon secrets`, `eidolon doctor`
- [ ] Logging: structured JSON logs with rotation
- [ ] Token/cost tracking: per-session accounting with model pricing table
- [ ] `eidolon doctor`: verify Bun version, Claude Code installed, config valid, database writable

**Exit criteria:** `eidolon doctor` passes all checks. `eidolon secrets set/list` works. Config validates.

---

## Phase 1: Brain

**Goal:** Send a message to Claude Code CLI and get a response back. Multi-account rotation works.

**Deliverables:**
- [ ] `ClaudeCodeManager`: spawn Claude Code CLI as subprocess, parse streaming JSON output
- [ ] `AccountRotation`: select best account, handle rate limits, failover to next
- [ ] `WorkspacePreparer`: create workspace directory, inject CLAUDE.md, SOUL.md
- [ ] `ProcessPool`: pre-warm Claude Code processes for instant response (~2s startup mitigation)
- [ ] Session management: main session persistence, `--resume`/`--session-id` for continuity
- [ ] Sub-agent routing: model selection by task type (Opus/Sonnet/Haiku)
- [ ] MCP server passthrough: forward configured MCP servers to Claude Code via `--mcp-config`
- [ ] `eidolon chat`: interactive CLI chat with Claude Code under the hood
- [ ] Basic error handling: auth failures, process crashes, timeout

**Exit criteria:** `eidolon chat` allows a multi-turn conversation with session resumption. If the primary account is rate-limited, the next account is used automatically. MCP servers are available in sessions. Token costs are tracked.

---

## Phase 2: Memory

**Goal:** Conversations are automatically analyzed, facts are extracted, and memory is available for future context.

**Deliverables:**
- [ ] `MemoryExtractor`: analyze conversation turns, extract facts/decisions/preferences
- [ ] `MemoryStore`: CRUD operations on the memories table, confidence management
- [ ] `MemorySearch`: hybrid BM25 + vector search using sqlite-vec and FTS5
- [ ] Graph memory: relationship edges between memories, graph-walk search expansion
- [ ] Local embeddings: `all-MiniLM-L6-v2` via `@huggingface/transformers` (ONNX, 384-dim)
- [ ] `MemoryInjector`: select relevant memories and write MEMORY.md before each session
- [ ] Document indexing: index personal files (markdown, text, PDF, code) from configured paths
- [ ] Dreaming Phase 1 (Housekeeping): deduplication, contradiction resolution, decay
- [ ] Dreaming Phase 2 (REM): associative discovery, graph edge creation
- [ ] Dreaming Phase 3 (NREM): schema abstraction, skill extraction from repeated patterns
- [ ] `eidolon memory search <query>`: CLI memory search
- [ ] `eidolon memory dream`: manually trigger dreaming

**Exit criteria:** After several conversations, `eidolon memory search` returns relevant facts including graph-connected memories. Dreaming produces consolidation entries and extracted skills. Document search works alongside conversation memory. MEMORY.md is populated with context-appropriate memories before each Claude Code session.

---

## Phase 3: Cognitive Loop & Multi-Session

**Goal:** Replace manual invocation with an autonomous loop that perceives, evaluates, acts, and reflects. Support concurrent sessions that communicate with each other.

**Deliverables:**
- [ ] `EventBus`: typed pub/sub system for internal events
- [ ] `CognitiveLoop`: continuous perceive-evaluate-act-reflect cycle
- [ ] `SessionSupervisor`: manage concurrent sessions (main, learning, task, dream, voice)
- [ ] Inter-session communication: typed messages via Event Bus
- [ ] Session lifecycle: spawn, pause, resume, terminate with priority-based interruption
- [ ] Priority evaluation: user messages > scheduled tasks > alerts > learning > dreaming
- [ ] Energy budget: token tracking per hour, allocation by category, budget enforcement
- [ ] Rest calculation: adaptive sleep duration based on user activity and time-of-day
- [ ] Scheduler: one-off, recurring, and conditional tasks (replaces cron)
- [ ] Daemon mode: `eidolon daemon start` runs the loop as a background process
- [ ] `eidolon daemon status`: show current loop state, active sessions, energy budget, pending events

**Exit criteria:** `eidolon daemon start` runs the cognitive loop with multi-session support. It responds to events, manages concurrent sessions, rests when idle, tracks energy budget, and can be stopped gracefully with `eidolon daemon stop`.

---

## Phase 4: Telegram

**Goal:** Full conversation with Eidolon via Telegram.

**Deliverables:**
- [ ] grammY bot setup with long polling
- [ ] Channel interface: `InboundMessage` and `OutboundMessage` types
- [ ] User allowlist: only configured Telegram user IDs can interact
- [ ] Text message handling: Telegram -> Event Bus -> Cognitive Loop -> Claude Code -> Telegram
- [ ] Streaming: long messages sent as "typing..." then edited with final response
- [ ] Media handling: photos, documents, voice messages received and passed to Claude
- [ ] Markdown rendering: Claude's markdown output formatted for Telegram
- [ ] `eidolon channel telegram status`: show bot status, message count

**Exit criteria:** A Telegram conversation with Eidolon works end-to-end. Memory is extracted from Telegram conversations. The bot only responds to allowed users.

---

## Phase 5: Self-Learning

**Goal:** Eidolon autonomously discovers, evaluates, and learns from the web during idle time.

**Deliverables:**
- [ ] `DiscoveryEngine`: crawl configured sources (Reddit, HN, GitHub, RSS)
- [ ] `RelevanceFilter`: use LLM to score relevance against user interests
- [ ] `LearningJournal`: markdown journal entries for each discovery
- [ ] `ImplementationPipeline`: auto-implement safe discoveries via Claude Code in a feature branch
- [ ] Safety classification: `safe` (store knowledge), `needs_approval` (ask user), `dangerous` (block)
- [ ] Deduplication: don't re-discover already-known content
- [ ] `eidolon learning status`: show discovery queue, implemented count
- [ ] `eidolon learning approve <id>`: approve pending implementations

**Exit criteria:** Eidolon discovers content during idle periods, filters by relevance, stores knowledge, and can implement code changes in a safe branch. Implementations require user approval unless classified as safe.

---

## Phase 6: Voice

**Goal:** Talk to Eidolon using your voice, with "Her"-style real-time streaming conversation and responses spoken back via Qwen3-TTS.

**Deliverables:**

*GPU Worker (Python/FastAPI):*
- [ ] GPU worker: Python FastAPI service with Qwen3-TTS model loaded
- [ ] TTS endpoint: `POST /tts/stream` with SSE audio chunk streaming
- [ ] STT endpoint: `POST /stt/transcribe` using Whisper
- [ ] Health endpoint: `GET /health` with GPU utilization, VRAM, temperature
- [ ] Real-time WebSocket: `WS /voice/realtime` with bidirectional audio streaming
- [ ] Docker deployment: `Dockerfile.cuda` for GPU worker with CUDA support

*Core Voice Pipeline:*
- [ ] `GpuManager` in core: discover workers, health monitoring, failover
- [ ] `StreamingVoicePipeline`: sentence-level TTS chunking from Claude's streaming output
- [ ] Voice state machine: idle/listening/processing/speaking/interrupted states
- [ ] Barge-in/interruption handling: cancel TTS, flush audio, transition to listening
- [ ] WebSocket protocol: binary+JSON messages for audio and control

*Integration:*
- [ ] Voice message flow: Telegram voice -> STT -> Claude -> TTS -> Telegram voice reply
- [ ] Fallback chain: Qwen3-TTS (GPU) -> Kitten TTS (CPU) -> System TTS -> text-only
- [ ] Voice metrics: latency P50/P95, interruption rate, fallback events
- [ ] VAD configuration: endpointing delay, speech threshold, min/max duration

**Exit criteria:** Send a voice message to Telegram, receive a voice response generated by Qwen3-TTS. Real-time voice WebSocket achieves <900ms median latency (silence to first audio). Barge-in interrupts playback within 200ms. Fallback to Kitten TTS works when GPU is offline. Voice metrics are tracked per session.

---

## Phase 7: Desktop Client

**Goal:** A native desktop app for macOS, Windows, and Linux.

**Deliverables:**
- [ ] Tauri 2.0 project setup with Svelte frontend
- [ ] WebSocket connection to Core gateway with authentication
- [ ] Chat interface: send/receive messages, streaming responses
- [ ] Memory browser: search and view memories
- [ ] Learning dashboard: view discoveries, approve implementations
- [ ] System tray: background operation with status indicator
- [ ] Voice mode: microphone input -> STT -> Claude -> TTS -> speakers
- [ ] Auto-update: Tauri's built-in updater with GitHub Releases
- [ ] GitHub Actions: build and release for macOS (Intel + ARM), Windows, Linux

**Exit criteria:** Desktop app connects to Core, chat works with streaming, memory browser returns results, system tray shows status. Builds successfully for all three platforms.

---

## Phase 8: iOS Client

**Goal:** A native iPhone/iPad app for Eidolon.

**Deliverables:**
- [ ] Swift/SwiftUI project setup
- [ ] WebSocket connection to Core gateway via Tailscale
- [ ] Chat interface with streaming responses
- [ ] Voice mode: microphone -> STT -> Claude -> TTS -> speaker
- [ ] Push notifications via APNs (requires Core to send notifications)
- [ ] Background refresh: keep connection alive
- [ ] TestFlight distribution for beta testing

**Exit criteria:** iOS app connects to Core over Tailscale, chat works, voice works, push notifications arrive. Available on TestFlight.

---

## Phase 9: Polish & Release

**Goal:** Production-ready v1.0 release.

**Deliverables:**
- [ ] CI/CD: GitHub Actions for test, lint, build, release
- [ ] Installation guide: step-by-step setup documentation
- [ ] Onboarding wizard: `eidolon onboard` walks through first-time setup
- [ ] Performance tuning: memory usage, startup time, database optimization
- [ ] Error recovery: graceful handling of all failure modes
- [ ] README update: screenshots, GIFs, getting-started guide
- [ ] GitHub Release: v1.0.0 with pre-built binaries
- [ ] npm publish: `@eidolon-ai/cli` package

**Exit criteria:** A new user can follow the installation guide, run `eidolon onboard`, connect Telegram, and have a working personal AI assistant within 30 minutes.

---

## Future (Post v1.0)

These features are intentionally deferred to keep the v1.0 scope tight:

| Feature | Description | Phase |
|---|---|---|
| Web Dashboard | Browser-based UI as alternative to desktop app | v1.1 |
| Multi-user | Support for household members with separate memory | v1.2 |
| WhatsApp channel | WhatsApp Business API integration | v1.1 |
| Discord channel | Discord bot integration | v1.1 |
| Email channel | IMAP/SMTP for email interaction | v1.2 |
| Calendar integration | Google Calendar / CalDAV sync | v1.1 |
| Smart home | Home Assistant / MQTT integration | v1.2 |
| Plugin system | Third-party extensions | v2.0 |
| Local LLM support | Ollama / llama.cpp as alternative brain | v2.0 |
| Multi-GPU | Distribute work across multiple GPU workers | v1.1 |
| Mobile widget | iOS home screen widget with quick actions | v1.1 |

## Versioning

Eidolon follows [Semantic Versioning](https://semver.org/):

- **0.x.y** -- Development phase. Breaking changes expected.
- **1.0.0** -- First stable release. All Phase 0-9 features complete.
- **1.x.0** -- New features, backward compatible.
- **2.0.0** -- Major architectural changes (plugin system, multi-user).
