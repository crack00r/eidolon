# Roadmap

> **Status: Design — not yet implemented.**
> Updated 2026-03-01 based on [expert review findings](REVIEW_FINDINGS.md).

Development is organized into phases. Each phase produces a working system that builds on the previous one. No phase begins until the prior phase is stable and tested.

## Overview

```
Phase 0: Foundation          (~2 weeks)    Monorepo, config, secrets, database, CI, testing
Phase 1: Brain               (~2 weeks)    Claude Code integration, single conversation
Phase 2: Memory              (~2 weeks)    Auto-extraction, search, dreaming
Phase 3: Cognitive Loop       (~2 weeks)    Event bus, loop, multi-session, energy budget
Phase 4: Telegram             (~1 week)     Telegram bot, message routing
Phase 4.5: Home Automation    (~1 week)     Basic HA integration via MCP
Phase 5: Self-Learning        (~2 weeks)    Discovery, filtering, implementation pipeline
Phase 6: Voice                (~2 weeks)    GPU worker, TTS/STT, real-time voice
Phase 7: Desktop Client       (~2 weeks)    Tauri app for macOS/Windows/Linux
Phase 8: iOS Client           (~6 weeks)    Swift app for iPhone/iPad
Phase 9: Polish & Release     (~1 week)     Docs, onboarding, performance, GitHub release
```

**Estimated total:** ~22 weeks for a complete v1.0 release.

**Strategic alternative (from competitive analysis):** Ship a minimal viable daemon (Phases 0-4) in ~8 weeks, then iterate. Accumulated memory is the moat — ship fast, get real usage.

---

## Phase 0: Foundation

**Goal:** A working monorepo with config loading, encrypted secrets, SQLite databases, CLI skeleton, CI pipeline, and test infrastructure.

**Deliverables:**
- [ ] pnpm workspace with `packages/core`, `packages/cli`, `packages/protocol`
- [ ] TypeScript + Bun configuration (tsconfig, biome for linting/formatting)
- [ ] **Compatibility verification:** `bun:sqlite` + `sqlite-vec`, `@huggingface/transformers` on Bun (document fallbacks: `better-sqlite3`, native ONNX runtime)
- [ ] Config system: load `eidolon.json`, validate with Zod, env variable overrides
- [ ] Secret store: AES-256-GCM encryption, Argon2id key derivation, CLI commands
- [ ] SQLite databases (3-database split):
  - `memory.db`: memories, embeddings, KG tables
  - `operational.db`: sessions, events, state, discoveries, token_usage
  - `audit.db`: audit log (append-only, rotatable)
  - Schema migration system for all three
- [ ] CLI skeleton: `eidolon daemon start|stop|status`, `eidolon config`, `eidolon secrets`, `eidolon doctor`
- [ ] Logging: structured JSON logs with rotation
- [ ] Token/cost tracking: per-session accounting with model pricing table
- [ ] `eidolon doctor`: verify Bun version, Claude Code installed, config valid, databases writable
- [ ] **CI pipeline (GitHub Actions):** lint (biome), typecheck (tsc), test (bun test) on every PR and push to main
- [ ] **Test infrastructure:** test runner config, first unit tests for config and secrets modules
- [ ] **systemd service file:** `eidolon.service` template for daemon deployment
- [ ] **Automated backup:** daily SQLite backup script to configurable path

**Exit criteria:** `eidolon doctor` passes all checks. `eidolon secrets set/list` works. Config validates. CI passes green. At least 10 unit tests cover config validation and secret encryption.

---

## Phase 1: Brain

**Goal:** Send a message to Claude Code CLI and get a response back. Multi-account rotation works.

**Deliverables:**
- [ ] `IClaudeProcess` interface: abstraction layer for Claude Code CLI (enables testing and future-proofing)
- [ ] `ClaudeCodeManager`: spawn Claude Code CLI as subprocess, parse streaming JSON output (implements `IClaudeProcess`)
- [ ] `FakeClaudeProcess`: test mock implementing `IClaudeProcess` with configurable responses
- [ ] `AccountRotation`: select best account, handle rate limits, failover to next
- [ ] `WorkspacePreparer`: create workspace directory, inject CLAUDE.md, SOUL.md
- [ ] Session management: main session persistence, `--resume`/`--session-id` for continuity
- [ ] Sub-agent routing: model selection by task type (Opus/Sonnet/Haiku)
- [ ] MCP server passthrough: forward configured MCP servers to Claude Code via `--mcp-config`
- [ ] `eidolon chat`: interactive CLI chat with Claude Code under the hood
- [ ] Error handling: auth failures, process crashes, timeout, rate limit backoff with exponential retry
- [ ] Immediate message acknowledgment: "Thinking..." sent before Claude processes
- [ ] Tool restriction by session type via `--allowedTools` whitelisting
- [ ] **Health check endpoint:** `GET /health` for monitoring

**Exit criteria:** `eidolon chat` allows a multi-turn conversation with session resumption. If the primary account is rate-limited, the next account is used automatically. MCP servers are available in sessions. Token costs are tracked. `FakeClaudeProcess` passes all integration tests without real API calls.

**Note:** Process pool pre-warming has been removed. Claude Code CLI does not support spawning a process and injecting a prompt later. Warm sessions via `--resume` are used instead. Accept ~2s cold start for new sessions.

---

## Phase 2: Memory

**Goal:** Conversations are automatically analyzed, facts are extracted, and memory is available for future context.

**Deliverables:**
- [ ] `MemoryExtractor`: analyze conversation turns, extract facts/decisions/preferences (with few-shot examples in prompts)
- [ ] `MemoryStore`: CRUD operations on the memories table, confidence management
- [ ] `MemorySearch`: hybrid BM25 + vector search using sqlite-vec and FTS5, with **Reciprocal Rank Fusion (RRF)**
- [ ] Graph memory: relationship edges between memories, graph-walk search expansion
- [ ] Local embeddings: **`multilingual-e5-small`** via `@huggingface/transformers` (ONNX, 384-dim, proper German support)
- [ ] `MemoryInjector`: select relevant memories and write MEMORY.md before each session
- [ ] Document indexing: index personal files (markdown, text, PDF, code) from configured paths
- [ ] Dreaming Phase 1 (Housekeeping): deduplication, contradiction resolution, decay
- [ ] Dreaming Phase 2 (REM): associative discovery, graph edge creation, **ComplEx** embedding training
- [ ] Dreaming Phase 3 (NREM): schema abstraction, skill extraction, Leiden community detection
- [ ] `eidolon memory search <query>`: CLI memory search
- [ ] `eidolon memory dream`: manually trigger dreaming
- [ ] **Entity resolution:** configurable similarity thresholds per entity type (persons 0.95, technology 0.90, concepts 0.85)
- [ ] **Golden dataset:** 50+ annotated conversation turns for extraction evaluation

**Exit criteria:** After several conversations, `eidolon memory search` returns relevant facts including graph-connected memories. Dreaming produces consolidation entries and extracted skills. Document search works alongside conversation memory. MEMORY.md is populated with context-appropriate memories before each Claude Code session. Memory extraction achieves >80% precision on golden dataset.

---

## Phase 3: Cognitive Loop & Multi-Session

**Goal:** Replace manual invocation with an autonomous loop that perceives, evaluates, acts, and reflects. Support concurrent sessions that communicate with each other.

**Deliverables:**
- [ ] `EventBus`: typed pub/sub system for internal events, **persisted to SQLite** (survives crashes)
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
- [ ] **Circuit breakers:** for Claude API, GPU worker, and Telegram with open/half-open/closed states
- [ ] **Backpressure:** drop low-priority events when Event Bus queue exceeds threshold
- [ ] **Retry logic:** exponential backoff (1s → 2s → 4s → 8s → max 60s) for transient failures
- [ ] **Basic Prometheus metrics:** loop cycle time, active sessions, token usage, event queue depth

**Exit criteria:** `eidolon daemon start` runs the cognitive loop with multi-session support. It responds to events, manages concurrent sessions, rests when idle, tracks energy budget, and can be stopped gracefully with `eidolon daemon stop`. Circuit breakers trip correctly on repeated failures.

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
- [ ] **Notification delivery:** critical/normal/low priority with DND schedule

**Exit criteria:** A Telegram conversation with Eidolon works end-to-end. Memory is extracted from Telegram conversations. The bot only responds to allowed users.

---

## Phase 4.5: Home Automation (Basic)

**Goal:** Basic Home Assistant integration via MCP server.

**Deliverables:**
- [ ] MCP server configuration for `mcp-server-home-assistant`
- [ ] Security policies for HA actions (lights: safe, locks/alarms: needs_approval)
- [ ] Entity resolution: map natural language to HA entity IDs
- [ ] Basic voice control via Telegram: "turn off the living room lights"
- [ ] HA state awareness in MEMORY.md context injection

**Exit criteria:** User can control basic HA entities (lights, switches, sensors) via Telegram through Eidolon. Critical devices require approval.

---

## Phase 5: Self-Learning

**Goal:** Eidolon autonomously discovers, evaluates, and learns from the web during idle time.

**Deliverables:**
- [ ] `DiscoveryEngine`: crawl configured sources (Reddit, HN, GitHub, RSS)
- [ ] `RelevanceFilter`: use LLM to score relevance against user interests
- [ ] `LearningJournal`: markdown journal entries for each discovery
- [ ] `ImplementationPipeline`: auto-implement safe discoveries via Claude Code in a feature branch
- [ ] Safety classification: `safe` (store knowledge), `needs_approval` (ask user), `dangerous` (block)
- [ ] **Code changes always require approval** (never auto-classified as safe)
- [ ] Content sanitization before LLM evaluation (prompt injection defense)
- [ ] Evaluation context uses restricted tools: `--allowedTools Read,Grep,Glob` (no shell, no write)
- [ ] Auto-lint and test after code changes (must pass before merge offered)
- [ ] Deduplication: don't re-discover already-known content
- [ ] `eidolon learning status`: show discovery queue, implemented count
- [ ] `eidolon learning approve <id>`: approve pending implementations

**Exit criteria:** Eidolon discovers content during idle periods, filters by relevance, stores knowledge, and can implement code changes in a safe branch. All code implementations require user approval. Auto-lint/test gates code changes.

---

## Phase 6: Voice

**Goal:** Talk to Eidolon using your voice, with "Her"-style real-time streaming conversation and responses spoken back via Qwen3-TTS.

**Deliverables:**

*GPU Worker (Python/FastAPI):*
- [ ] GPU worker: Python FastAPI service with Qwen3-TTS model loaded
- [ ] **Pre-shared key authentication** on all endpoints (from secret store)
- [ ] TTS endpoint: `POST /tts/stream` with SSE audio chunk streaming
- [ ] STT endpoint: `POST /stt/transcribe` using **faster-whisper** (not Whisper Large v3)
- [ ] Health endpoint: `GET /health` with GPU utilization, VRAM, temperature
- [ ] Real-time WebSocket: `WS /voice/realtime` with **Opus codec** (not raw PCM)
- [ ] Docker deployment: `Dockerfile.cuda` for GPU worker with CUDA support

*Core Voice Pipeline:*
- [ ] `GpuManager` in core: discover workers, health monitoring, failover
- [ ] `StreamingVoicePipeline`: sentence-level TTS chunking using **`Intl.Segmenter`** (not regex)
- [ ] **Audio preprocessing pipeline:** high-pass filter → AGC → noise suppression
- [ ] Voice state machine: idle/listening/processing/speaking/interrupted states
- [ ] Barge-in/interruption handling: cancel TTS, flush audio, transition to listening
- [ ] **Client-side jitter buffer:** 50-150ms configurable
- [ ] **Echo cancellation:** WebRTC AEC3 recommended, VAD gating as fallback
- [ ] WebSocket protocol: **Opus-encoded** binary + JSON messages for audio and control

*Integration:*
- [ ] Voice message flow: Telegram voice -> STT -> Claude -> TTS -> Telegram voice reply
- [ ] Fallback chain: Qwen3-TTS (GPU) -> Kitten TTS (CPU) -> System TTS -> text-only
- [ ] Voice metrics: latency P50/P95, interruption rate, fallback events
- [ ] VAD configuration: endpointing delay, speech threshold, min/max duration

**Exit criteria:** Send a voice message to Telegram, receive a voice response generated by Qwen3-TTS. Real-time voice WebSocket achieves <1500ms median latency (realistic target; 900ms as P10 stretch goal). Barge-in interrupts playback within 200ms. Fallback to Kitten TTS works when GPU is offline. Voice metrics are tracked per session.

---

## Phase 7: Desktop Client

**Goal:** A native desktop app for macOS, Windows, and Linux.

**Deliverables:**
- [ ] Tauri 2.0 project setup with Svelte frontend
- [ ] WebSocket connection to Core gateway with authentication
- [ ] Chat interface: send/receive messages, streaming responses
- [ ] Memory browser: search and view memories, **edit/delete individual memories**
- [ ] Learning dashboard: view discoveries, approve implementations
- [ ] System tray: background operation with status indicator
- [ ] Voice mode: microphone input -> STT -> Claude -> TTS -> speakers
- [ ] Auto-update: Tauri's built-in updater with GitHub Releases
- [ ] GitHub Actions: build and release for macOS (Intel + ARM), Windows, Linux
- [ ] **Keyboard navigation and screen reader support** (WCAG 2.1 AA)
- [ ] **Error states and offline mode UI**

**Exit criteria:** Desktop app connects to Core, chat works with streaming, memory browser returns results, system tray shows status. Builds successfully for all three platforms.

---

## Phase 8: iOS Client

**Goal:** A native iPhone/iPad app for Eidolon.

**Timeline:** ~6 weeks (updated from original 2-week estimate based on review)

**Deliverables:**
- [ ] Swift/SwiftUI project setup
- [ ] **Dual networking:** Tailscale for home network + **Cloudflare Tunnel** for mobile without VPN
- [ ] WebSocket connection to Core gateway (foreground only)
- [ ] **APNs server-side implementation** in Core for push notifications
- [ ] Chat interface with streaming responses
- [ ] Voice mode: microphone -> STT -> Claude -> TTS -> speaker
- [ ] Push notifications via APNs (learning findings, reminders, critical alerts)
- [ ] Background refresh: periodic catch-up via APNs-triggered fetch
- [ ] TestFlight distribution for beta testing
- [ ] **VoiceOver accessibility support**

**Exit criteria:** iOS app connects to Core over Tailscale or Cloudflare Tunnel, chat works, voice works, push notifications arrive. Available on TestFlight.

---

## Phase 9: Polish & Release

**Goal:** Production-ready v1.0 release.

**Deliverables:**
- [ ] Installation guide: step-by-step setup documentation
- [ ] Onboarding wizard: `eidolon onboard` walks through first-time setup
- [ ] Performance tuning: memory usage, startup time, database optimization
- [ ] Error recovery: graceful handling of all failure modes
- [ ] README update: screenshots, GIFs, getting-started guide
- [ ] GitHub Release: v1.0.0 with pre-built binaries
- [ ] npm publish: `@eidolon-ai/cli` package
- [ ] **GDPR compliance:** `eidolon privacy forget`, `eidolon privacy export`
- [ ] **Glossary and troubleshooting docs**

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
| Advanced Home Automation | Voice-controlled HA, automation scenes, proactive suggestions | v1.1 |
| Plugin system | Third-party extensions | v2.0 |
| Local LLM support | Ollama / llama.cpp as alternative brain | v2.0 |
| Multi-GPU | Distribute work across multiple GPU workers | v1.1 |
| Mobile widget | iOS home screen widget with quick actions | v1.1 |
| Distributed tracing | OpenTelemetry for debugging | v1.1 |
| Secondary node replication | Disaster recovery to secondary server | v2.0 |

## Versioning

Eidolon follows [Semantic Versioning](https://semver.org/):

- **0.x.y** -- Development phase. Breaking changes expected.
- **1.0.0** -- First stable release. All Phase 0-9 features complete.
- **1.x.0** -- New features, backward compatible.
- **2.0.0** -- Major architectural changes (plugin system, multi-user).
