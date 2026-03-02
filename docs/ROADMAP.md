# Roadmap

> **Status: Implemented — v0.1.4 released. All phases scaffolded and tested (815 tests, 0 typecheck errors).**
> Updated 2026-03-02. All phases implemented per [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

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
- [x] pnpm workspace with `packages/core`, `packages/cli`, `packages/protocol`
- [x] TypeScript + Bun configuration (tsconfig, biome for linting/formatting)
- [x] **Compatibility verification:** `bun:sqlite` + `sqlite-vec`, `@huggingface/transformers` on Bun (document fallbacks: `better-sqlite3`, native ONNX runtime)
- [x] Config system: load `eidolon.json`, validate with Zod, env variable overrides
- [x] Secret store: AES-256-GCM encryption, Argon2id key derivation, CLI commands
- [x] SQLite databases (3-database split):
  - `memory.db`: memories, embeddings, KG tables
  - `operational.db`: sessions, events, state, discoveries, token_usage
  - `audit.db`: audit log (append-only, rotatable)
  - Schema migration system for all three
- [x] CLI skeleton: `eidolon daemon start|stop|status`, `eidolon config`, `eidolon secrets`, `eidolon doctor`
- [x] Logging: structured JSON logs with rotation
- [x] Token/cost tracking: per-session accounting with model pricing table
- [x] `eidolon doctor`: verify Bun version, Claude Code installed, config valid, databases writable
- [x] **CI pipeline (GitHub Actions):** lint (biome), typecheck (tsc), test (bun test) on every PR and push to main
- [x] **Test infrastructure:** test runner config, first unit tests for config and secrets modules
- [x] **systemd service file:** `eidolon.service` template for daemon deployment
- [x] **Automated backup:** daily SQLite backup script to configurable path

**Exit criteria:** `eidolon doctor` passes all checks. `eidolon secrets set/list` works. Config validates. CI passes green. At least 10 unit tests cover config validation and secret encryption.

---

## Phase 1: Brain

**Goal:** Send a message to Claude Code CLI and get a response back. Multi-account rotation works.

**Deliverables:**
- [x] `IClaudeProcess` interface: abstraction layer for Claude Code CLI (enables testing and future-proofing)
- [x] `ClaudeCodeManager`: spawn Claude Code CLI as subprocess, parse streaming JSON output (implements `IClaudeProcess`)
- [x] `FakeClaudeProcess`: test mock implementing `IClaudeProcess` with configurable responses
- [x] `AccountRotation`: select best account, handle rate limits, failover to next
- [x] `WorkspacePreparer`: create workspace directory, inject CLAUDE.md, SOUL.md
- [x] Session management: main session persistence, `--resume`/`--session-id` for continuity
- [x] Sub-agent routing: model selection by task type (Opus/Sonnet/Haiku)
- [x] MCP server passthrough: forward configured MCP servers to Claude Code via `--mcp-config`
- [x] `eidolon chat`: interactive CLI chat with Claude Code under the hood
- [x] Error handling: auth failures, process crashes, timeout, rate limit backoff with exponential retry
- [x] Immediate message acknowledgment: "Thinking..." sent before Claude processes
- [x] Tool restriction by session type via `--allowedTools` whitelisting
- [x] **Health check endpoint:** `GET /health` for monitoring

**Exit criteria:** `eidolon chat` allows a multi-turn conversation with session resumption. If the primary account is rate-limited, the next account is used automatically. MCP servers are available in sessions. Token costs are tracked. `FakeClaudeProcess` passes all integration tests without real API calls.

**Note:** Process pool pre-warming has been removed. Claude Code CLI does not support spawning a process and injecting a prompt later. Warm sessions via `--resume` are used instead. Accept ~2s cold start for new sessions.

---

## Phase 2: Memory

**Goal:** Conversations are automatically analyzed, facts are extracted, and memory is available for future context.

**Deliverables:**
- [x] `MemoryExtractor`: analyze conversation turns, extract facts/decisions/preferences (with few-shot examples in prompts)
- [x] `MemoryStore`: CRUD operations on the memories table, confidence management
- [x] `MemorySearch`: hybrid BM25 + vector search using sqlite-vec and FTS5, with **Reciprocal Rank Fusion (RRF)**
- [x] Graph memory: relationship edges between memories, graph-walk search expansion
- [x] Local embeddings: **`multilingual-e5-small`** via `@huggingface/transformers` (ONNX, 384-dim, proper German support)
- [x] `MemoryInjector`: select relevant memories and write MEMORY.md before each session
- [x] Document indexing: index personal files (markdown, text, PDF, code) from configured paths
- [x] Dreaming Phase 1 (Housekeeping): deduplication, contradiction resolution, decay
- [x] Dreaming Phase 2 (REM): associative discovery, graph edge creation, **ComplEx** embedding training
- [x] Dreaming Phase 3 (NREM): schema abstraction, skill extraction, Leiden community detection
- [x] `eidolon memory search <query>`: CLI memory search
- [x] `eidolon memory dream`: manually trigger dreaming
- [x] **Entity resolution:** configurable similarity thresholds per entity type (persons 0.95, technology 0.90, concepts 0.85)
- [x] **Golden dataset:** 50+ annotated conversation turns for extraction evaluation

**Exit criteria:** After several conversations, `eidolon memory search` returns relevant facts including graph-connected memories. Dreaming produces consolidation entries and extracted skills. Document search works alongside conversation memory. MEMORY.md is populated with context-appropriate memories before each Claude Code session. Memory extraction achieves >80% precision on golden dataset.

---

## Phase 3: Cognitive Loop & Multi-Session

**Goal:** Replace manual invocation with an autonomous loop that perceives, evaluates, acts, and reflects. Support concurrent sessions that communicate with each other.

**Deliverables:**
- [x] `EventBus`: typed pub/sub system for internal events, **persisted to SQLite** (survives crashes)
- [x] `CognitiveLoop`: continuous perceive-evaluate-act-reflect cycle
- [x] `SessionSupervisor`: manage concurrent sessions (main, learning, task, dream, voice)
- [x] Inter-session communication: typed messages via Event Bus
- [x] Session lifecycle: spawn, pause, resume, terminate with priority-based interruption
- [x] Priority evaluation: user messages > scheduled tasks > alerts > learning > dreaming
- [x] Energy budget: token tracking per hour, allocation by category, budget enforcement
- [x] Rest calculation: adaptive sleep duration based on user activity and time-of-day
- [x] Scheduler: one-off, recurring, and conditional tasks (replaces cron)
- [x] Daemon mode: `eidolon daemon start` runs the loop as a background process
- [x] `eidolon daemon status`: show current loop state, active sessions, energy budget, pending events
- [x] **Circuit breakers:** for Claude API, GPU worker, and Telegram with open/half-open/closed states
- [x] **Backpressure:** drop low-priority events when Event Bus queue exceeds threshold
- [x] **Retry logic:** exponential backoff (1s → 2s → 4s → 8s → max 60s) for transient failures
- [x] **Basic Prometheus metrics:** loop cycle time, active sessions, token usage, event queue depth

**Exit criteria:** `eidolon daemon start` runs the cognitive loop with multi-session support. It responds to events, manages concurrent sessions, rests when idle, tracks energy budget, and can be stopped gracefully with `eidolon daemon stop`. Circuit breakers trip correctly on repeated failures.

---

## Phase 4: Telegram

**Goal:** Full conversation with Eidolon via Telegram.

**Deliverables:**
- [x] grammY bot setup with long polling
- [x] Channel interface: `InboundMessage` and `OutboundMessage` types
- [x] User allowlist: only configured Telegram user IDs can interact
- [x] Text message handling: Telegram -> Event Bus -> Cognitive Loop -> Claude Code -> Telegram
- [x] Streaming: long messages sent as "typing..." then edited with final response
- [x] Media handling: photos, documents, voice messages received and passed to Claude
- [x] Markdown rendering: Claude's markdown output formatted for Telegram
- [x] `eidolon channel telegram status`: show bot status, message count
- [x] **Notification delivery:** critical/normal/low priority with DND schedule

**Exit criteria:** A Telegram conversation with Eidolon works end-to-end. Memory is extracted from Telegram conversations. The bot only responds to allowed users.

---

## Phase 4.5: Home Automation (Basic)

**Goal:** Basic Home Assistant integration via MCP server.

**Deliverables:**
- [x] MCP server configuration for `mcp-server-home-assistant`
- [x] Security policies for HA actions (lights: safe, locks/alarms: needs_approval)
- [x] Entity resolution: map natural language to HA entity IDs
- [x] Basic voice control via Telegram: "turn off the living room lights"
- [x] HA state awareness in MEMORY.md context injection

**Exit criteria:** User can control basic HA entities (lights, switches, sensors) via Telegram through Eidolon. Critical devices require approval.

---

## Phase 5: Self-Learning

**Goal:** Eidolon autonomously discovers, evaluates, and learns from the web during idle time.

**Deliverables:**
- [x] `DiscoveryEngine`: crawl configured sources (Reddit, HN, GitHub, RSS)
- [x] `RelevanceFilter`: use LLM to score relevance against user interests
- [x] `LearningJournal`: markdown journal entries for each discovery
- [x] `ImplementationPipeline`: auto-implement safe discoveries via Claude Code in a feature branch
- [x] Safety classification: `safe` (store knowledge), `needs_approval` (ask user), `dangerous` (block)
- [x] **Code changes always require approval** (never auto-classified as safe)
- [x] Content sanitization before LLM evaluation (prompt injection defense)
- [x] Evaluation context uses restricted tools: `--allowedTools Read,Grep,Glob` (no shell, no write)
- [x] Auto-lint and test after code changes (must pass before merge offered)
- [x] Deduplication: don't re-discover already-known content
- [x] `eidolon learning status`: show discovery queue, implemented count
- [x] `eidolon learning approve <id>`: approve pending implementations

**Exit criteria:** Eidolon discovers content during idle periods, filters by relevance, stores knowledge, and can implement code changes in a safe branch. All code implementations require user approval. Auto-lint/test gates code changes.

---

## Phase 6: Voice

**Goal:** Talk to Eidolon using your voice, with "Her"-style real-time streaming conversation and responses spoken back via Qwen3-TTS.

**Deliverables:**

*GPU Worker (Python/FastAPI):*
- [x] GPU worker: Python FastAPI service with Qwen3-TTS model loaded
- [x] **Pre-shared key authentication** on all endpoints (from secret store)
- [x] TTS endpoint: `POST /tts/stream` with SSE audio chunk streaming
- [x] STT endpoint: `POST /stt/transcribe` using **faster-whisper** (not Whisper Large v3)
- [x] Health endpoint: `GET /health` with GPU utilization, VRAM, temperature
- [x] Real-time WebSocket: `WS /voice/realtime` with **Opus codec** (not raw PCM)
- [x] Docker deployment: `Dockerfile.cuda` for GPU worker with CUDA support

*Core Voice Pipeline:*
- [x] `GpuManager` in core: discover workers, health monitoring, failover
- [x] `StreamingVoicePipeline`: sentence-level TTS chunking using **`Intl.Segmenter`** (not regex)
- [x] **Audio preprocessing pipeline:** high-pass filter → AGC → noise suppression
- [x] Voice state machine: idle/listening/processing/speaking/interrupted states
- [x] Barge-in/interruption handling: cancel TTS, flush audio, transition to listening
- [x] **Client-side jitter buffer:** 50-150ms configurable
- [x] **Echo cancellation:** WebRTC AEC3 recommended, VAD gating as fallback
- [x] WebSocket protocol: **Opus-encoded** binary + JSON messages for audio and control

*Integration:*
- [x] Voice message flow: Telegram voice -> STT -> Claude -> TTS -> Telegram voice reply
- [x] Fallback chain: Qwen3-TTS (GPU) -> Kitten TTS (CPU) -> System TTS -> text-only
- [x] Voice metrics: latency P50/P95, interruption rate, fallback events
- [x] VAD configuration: endpointing delay, speech threshold, min/max duration

**Exit criteria:** Send a voice message to Telegram, receive a voice response generated by Qwen3-TTS. Real-time voice WebSocket achieves <1500ms median latency (realistic target; 900ms as P10 stretch goal). Barge-in interrupts playback within 200ms. Fallback to Kitten TTS works when GPU is offline. Voice metrics are tracked per session.

---

## Phase 7: Desktop Client

**Goal:** A native desktop app for macOS, Windows, and Linux.

**Deliverables:**
- [x] Tauri 2.0 project setup with Svelte frontend
- [x] WebSocket connection to Core gateway with authentication
- [x] Chat interface: send/receive messages, streaming responses
- [x] Memory browser: search and view memories, **edit/delete individual memories**
- [x] Learning dashboard: view discoveries, approve implementations
- [x] System tray: background operation with status indicator
- [x] Voice mode: microphone input -> STT -> Claude -> TTS -> speakers
- [x] Auto-update: Tauri's built-in updater with GitHub Releases
- [x] GitHub Actions: build and release for macOS (Intel + ARM), Windows, Linux
- [x] **Keyboard navigation and screen reader support** (WCAG 2.1 AA)
- [x] **Error states and offline mode UI**

**Exit criteria:** Desktop app connects to Core, chat works with streaming, memory browser returns results, system tray shows status. Builds successfully for all three platforms.

---

## Phase 8: iOS Client

**Goal:** A native iPhone/iPad app for Eidolon.

**Timeline:** ~6 weeks (updated from original 2-week estimate based on review)

**Deliverables:**
- [x] Swift/SwiftUI project setup
- [x] **Dual networking:** Tailscale for home network + **Cloudflare Tunnel** for mobile without VPN
- [x] WebSocket connection to Core gateway (foreground only)
- [x] **APNs server-side implementation** in Core for push notifications
- [x] Chat interface with streaming responses
- [x] Voice mode: microphone -> STT -> Claude -> TTS -> speaker
- [x] Push notifications via APNs (learning findings, reminders, critical alerts)
- [x] Background refresh: periodic catch-up via APNs-triggered fetch
- [x] TestFlight distribution for beta testing
- [x] **VoiceOver accessibility support**

**Exit criteria:** iOS app connects to Core over Tailscale or Cloudflare Tunnel, chat works, voice works, push notifications arrive. Available on TestFlight.

---

## Phase 9: Polish & Release

**Goal:** Production-ready v1.0 release.

**Deliverables:**
- [x] Installation guide: step-by-step setup documentation
- [x] Onboarding wizard: `eidolon onboard` walks through first-time setup
- [x] Performance tuning: memory usage, startup time, database optimization
- [x] Error recovery: graceful handling of all failure modes
- [x] README update: screenshots, GIFs, getting-started guide
- [x] GitHub Release: v1.0.0 with pre-built binaries
- [x] npm publish: `@eidolon-ai/cli` package
- [x] **GDPR compliance:** `eidolon privacy forget`, `eidolon privacy export`
- [x] **Glossary and troubleshooting docs**

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
