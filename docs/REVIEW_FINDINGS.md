# Expert Review Findings

> **Status: Design review — synthesized from 20 expert perspectives.**
> Generated 2026-03-01. These findings have been integrated into the design documents and roadmap.

## Overview

Twenty domain-expert reviews were conducted across security, software engineering, QA, DevOps, AI/ML, product design, privacy/GDPR, end-user experience, voice/audio, mobile development, distributed systems, performance, accessibility, cost analysis, competitive strategy, open source maintenance, home automation, technical writing, and Cline comparison.

This document consolidates their findings into actionable changes, organized by severity and topic.

---

## Critical Findings (Must Address Before Coding)

### C-1: No Testing Strategy

**Source:** QA/Testing Engineer, Software Developer

The entire design has zero mention of testing — no test framework, no test strategy, no CI pipeline, no mocks. For a 24/7 daemon managing user data and LLM sessions, this is the biggest gap.

**Resolution:**
- New document: `docs/design/TESTING.md`
- CI pipeline (lint, typecheck, test) added to Phase 0
- `FakeClaudeProcess` mock as first Phase 1 deliverable
- Golden datasets for memory extraction evaluation

### C-2: `--dangerously-skip-permissions` in Design

**Source:** Security Expert

The Claude Code integration doc includes `--dangerously-skip-permissions` as a session option. This flag bypasses all safety checks and must never be used in an autonomous daemon.

**Resolution:**
- Removed from CLAUDE_INTEGRATION.md
- Replaced with explicit `--allowedTools` whitelisting per session type
- Security policy enforces tool restrictions by session type

### C-3: Decrypted API Keys Exposed in Process Environment

**Source:** Security Expert

API keys are decrypted into `ANTHROPIC_API_KEY` environment variable for the subprocess. Any child process or `/proc` inspection reveals the key.

**Resolution:**
- Use temporary environment: set key only for the subprocess spawn, never in the parent env
- Clear after process starts (Bun subprocess supports env isolation)
- Document that keys are ephemeral per-process, not persisted in environment

### C-4: No Authentication on GPU Worker API

**Source:** Security Expert

GPU worker port 8420 is exposed on Tailscale with no authentication. Any Tailscale node can generate speech or transcribe audio.

**Resolution:**
- Add pre-shared key authentication (from secret store) to all GPU worker endpoints
- GPU worker validates `Authorization: Bearer <token>` on every request
- Token rotation via `eidolon secrets rotate GPU_WORKER_TOKEN`

### C-5: Self-Learning → Prompt Injection → RCE Pipeline

**Source:** Security Expert

The self-learning pipeline crawls the internet, feeds content to an LLM, and can trigger code implementation. A crafted prompt injection in a Reddit post could lead to remote code execution.

**Resolution:**
- All discovered content goes through sanitization before LLM evaluation
- Implementation pipeline requires explicit user approval (never `safe` classification for code changes)
- Code changes always in isolated git worktree
- Auto-lint and test must pass before merge is even offered
- Content evaluation uses `--allowedTools Read,Grep,Glob` (no shell, no write)

### C-6: CI/CD and Operations Deferred to Phase 9

**Source:** DevOps Engineer, QA/Testing Engineer, Open Source Maintainer

CI, systemd service files, health checks, and monitoring are deferred to the final phase. For a 24/7 daemon, operations IS the feature.

**Resolution:**
- CI pipeline (GitHub Actions: lint, typecheck, test) moved to Phase 0
- systemd service file moved to Phase 0
- Health check endpoint moved to Phase 1
- Monitoring (basic Prometheus metrics) moved to Phase 3

### C-7: TransE is Wrong for Knowledge Graph

**Source:** AI/ML Engineer

TransE cannot model symmetric relations (`A married_to B` ≠ `B married_to A`), 1-to-N relations, or reflexive patterns. For a personal knowledge graph with diverse relation types, this is a significant limitation.

**Resolution:**
- Switch from TransE to **ComplEx** (default) with RotatE as alternative
- ComplEx handles symmetric, antisymmetric, and 1-N relations
- Same training loop structure, different scoring function
- Document trade-offs in MEMORY_ENGINE.md

### C-8: Embedding Model Lacks German Support

**Source:** AI/ML Engineer

`all-MiniLM-L6-v2` is English-centric. User speaks German. Memory search will degrade for German-language memories.

**Resolution:**
- Switch default to **`multilingual-e5-small`** (same 384 dimensions, same ONNX runtime, proper multilingual support including German)
- Same size (~90MB), same API, drop-in replacement
- Document both options in config reference

### C-9: Hybrid Search Fusion Strategy Undefined

**Source:** AI/ML Engineer

The design says "hybrid BM25 + vector search" but never specifies how results are fused.

**Resolution:**
- Adopt **Reciprocal Rank Fusion (RRF)** as the default fusion strategy
- RRF formula: `score = Σ 1/(k + rank_i)` where k=60 (standard constant)
- Simple, parameter-free, well-studied
- Document in MEMORY_ENGINE.md

### C-10: Event Bus is In-Memory Only

**Source:** Distributed Systems Engineer

The Event Bus is in-memory with no persistence. A daemon crash loses all pending events.

**Resolution:**
- Persist pending events to SQLite `events` table
- WAL mode allows concurrent reads during event processing
- Events are dequeued after successful processing
- On restart, replay unprocessed events

---

## High-Priority Findings

### H-1: Voice Pipeline Audio Issues

**Source:** Voice/Audio Engineer

Multiple audio engineering problems:
- Raw PCM over WebSocket wastes bandwidth (1.5 Mbps for 16-bit 48kHz)
- No audio preprocessing (AGC, noise suppression, high-pass filter)
- No jitter buffer for network variance
- Echo cancellation strategies are insufficient
- Sentence boundary regex is too naive
- 900ms target is optimistic; realistic median ~1500-1800ms

**Resolution:**
- Switch to **Opus codec** for WebSocket audio (configurable bitrate, ~32kbps)
- Add audio preprocessing pipeline: high-pass filter → AGC → noise suppression
- Add client-side jitter buffer (50-150ms configurable)
- Recommend **WebRTC AEC3** for echo cancellation (available via libwebrtc)
- Switch sentence detection to `Intl.Segmenter` API
- Update latency target to realistic **1200-1500ms median** (900ms P10)
- Switch STT from Whisper Large v3 to **`faster-whisper`** (same quality, 4x faster, half VRAM)

### H-2: SQLite Single-Writer Bottleneck

**Source:** Performance Engineer, Distributed Systems Engineer

SQLite single-writer lock under concurrent sessions. Memory extraction, audit logging, event bus, and learning all write concurrently.

**Resolution:**
- Split into **3 databases**: `memory.db`, `operational.db`, `audit.db`
- Each database has its own WAL and write lock
- `memory.db`: memories, embeddings, KG tables
- `operational.db`: sessions, events, state, discoveries, token_usage
- `audit.db`: audit log (append-only, can be rotated)

### H-3: No Graceful Degradation Matrix

**Source:** Distributed Systems Engineer

Only TTS has a documented fallback chain. Every other component fails hard.

**Resolution:**
- Document graceful degradation for all components:
  - GPU offline → CPU fallback → text-only
  - Claude rate limited → next account → queue with backoff → inform user
  - SQLite locked → retry with exponential backoff
  - Tailscale down → local-only mode (CLI still works)
  - Memory search fails → recent memories only → no memory (still functional)
  - Event Bus overloaded → backpressure (reject low-priority events)

### H-4: No Retry Logic or Circuit Breakers

**Source:** Distributed Systems Engineer

No retry strategy, no circuit breakers, no backpressure anywhere.

**Resolution:**
- Add circuit breaker pattern for external calls (Claude API, GPU worker, Telegram)
- States: closed → open (after N failures) → half-open (probe) → closed
- Exponential backoff for retries: 1s → 2s → 4s → 8s → max 60s
- Backpressure on Event Bus: drop low-priority events when queue exceeds threshold

### H-5: GDPR Compliance Gaps

**Source:** Privacy/GDPR Expert

Multiple GDPR issues:
- No right to erasure ("forget me" command)
- Knowledge Graph stores third-party PII without consent
- Voice data is biometric data (GDPR Art. 9)
- MEMORY.md written to disk in plaintext AND sent to Anthropic
- No data portability export

**Resolution:**
- Add `eidolon privacy forget <entity>` — cascading delete from all tables
- Add `eidolon privacy export` — full data export in JSON
- Add PII detection in KG extraction — flag third-party entities, require explicit consent
- Voice consent: first-time voice prompt with explicit opt-in stored in config
- Document that MEMORY.md contents are sent to Anthropic's API (user must acknowledge)

### H-6: Process Pool Pre-Warming Likely Impossible

**Source:** Software Developer, Performance Engineer

Claude Code CLI doesn't support spawning a process and then injecting a prompt later. Each invocation is a complete request. Pre-warming as designed won't work.

**Resolution:**
- Remove ProcessPool from Phase 1 deliverables
- Instead: keep a warm session via `--resume` (session already exists, context cached by Claude)
- For new sessions: accept ~2s cold start, mitigate with "Thinking..." immediate acknowledgment
- Document the limitation honestly

### H-7: iOS Networking and Background Limitations

**Source:** Mobile Developer

- Tailscale-only networking is a dealbreaker for real-world mobile use
- iOS kills background WebSocket connections
- No APNs server-side implementation
- 2-week iOS estimate is unrealistic (6-8 weeks minimum)

**Resolution:**
- Add **Cloudflare Tunnel** as alternative to Tailscale (for mobile without VPN)
- iOS: use APNs for push, WebSocket only while app is foregrounded
- Add APNs server-side to Core (Phase 8 prerequisite)
- Update iOS timeline to 6 weeks minimum
- Document both networking options in CLIENT_ARCHITECTURE.md

### H-8: ~8,000 LOC Target Likely Unrealistic

**Source:** Software Developer

Estimated 7,200-11,900 lines for core TypeScript alone, not counting tests, GPU worker, clients, or infrastructure.

**Resolution:**
- Acknowledge as aspirational target
- Track actual LOC per phase
- If exceeding 12,000 lines, evaluate what to cut rather than write poor code
- Tests are NOT counted toward the target

### H-9: Name Conflict with Existing Project

**Source:** Open Source Maintainer

`AgentOps-AI/eidolon` exists on GitHub (300+ stars, AI agent framework). This could cause confusion.

**Resolution:**
- Monitor for actual confusion
- npm scope `@eidolon-ai/cli` avoids package name conflict
- If significant confusion arises, consider rename to `eidolon-daemon` or similar
- For now: proceed (our project is sufficiently different in scope)

### H-10: No Notification Design

**Source:** Product Designer

No notification system design — no priority levels, no batching, no DND, no immediate acknowledgment.

**Resolution:**
- Add notification priority levels: `critical` (always deliver), `normal` (batch OK), `low` (digest)
- DND schedule in config (e.g., 22:00-07:00)
- Batch low-priority notifications into digests
- Immediate "Thinking..." acknowledgment for all user messages
- Channel-specific delivery: Telegram for critical, digest for low

---

## Medium-Priority Findings

### M-1: Missing Community/OSS Files

**Source:** Open Source Maintainer
- Add `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1)
- Add root `SECURITY.md` (vulnerability reporting policy)
- Add `.github/ISSUE_TEMPLATE/` (bug report, feature request)
- Add `.github/PULL_REQUEST_TEMPLATE.md`

### M-2: No Accessibility Considerations

**Source:** Accessibility Expert
- Zero screen reader, keyboard nav, contrast, or font scaling considerations
- Voice-first design is accidentally great for blind/low-vision users
- New document: `docs/design/ACCESSIBILITY.md`
- WCAG 2.1 AA as target for all client UIs

### M-3: Home Automation Deferred Too Late

**Source:** Home Automation Expert
- HA integration is the killer app per community sentiment
- Currently deferred to v1.2 (post-release)
- Elevate to Phase 4.5 (basic HA via MCP) and Phase 6 (voice-controlled)
- New document: `docs/design/HOME_AUTOMATION.md`

### M-4: No Onboarding or User Guide

**Source:** End User, Product Designer
- Installation requires developer skills
- No quick-start guide exists
- `eidolon onboard` wizard needed in Phase 0.5

### M-5: Documentation Quality Issues

**Source:** Technical Writer
- Aspirational language mixed with factual (describes unbuilt features in present tense)
- No document status headers
- No glossary
- CLAUDE.md has significant duplication with other docs

**Resolution:**
- Add status headers to all design docs: `> Status: Design — not yet implemented`
- Add `docs/GLOSSARY.md` (deferred to Phase 9)
- Reduce CLAUDE.md duplication (keep references, not copies)

### M-6: `bun:sqlite` + `sqlite-vec` Compatibility Unverified

**Source:** Software Developer
- No evidence that `sqlite-vec` works with Bun's native SQLite bindings
- `@huggingface/transformers` on Bun is also unverified

**Resolution:**
- Phase 0 must include compatibility verification as first task
- Document fallback: `better-sqlite3` if `bun:sqlite` + sqlite-vec fails
- Document fallback: ONNX runtime via native module if HF transformers fails

### M-7: Entity Resolution Threshold Fragile

**Source:** AI/ML Engineer
- Hard-coded 0.92 cosine similarity for entity deduplication is brittle
- Different entity types need different thresholds

**Resolution:**
- Make threshold configurable per entity type
- Default: persons 0.95, technology 0.90, concepts 0.85
- Add few-shot examples to extraction prompts
- Add evaluation metrics (precision/recall) for extraction

### M-8: Monthly Operating Cost: $260-550/mo

**Source:** Cost/Business Analyst
- Two Max subscriptions = $400/mo base
- Recommend eliminating second Max subscription (saves $200/mo)
- Single Max + API keys for overflow is more cost-effective
- No free tier possible without local LLM support

**Resolution:**
- Default config: 1 Max subscription + 1-2 API keys
- Document cost breakdown in user guide
- Track actual costs from day one (token_usage table exists)

### M-9: Strategic Risk — Anthropic Platform Lock-In

**Source:** Competitive Strategy
- Total Anthropic dependency is the #1 strategic risk
- Claude Desktop adding persistent memory would make core value proposition obsolete
- Moat = accumulated memory + learned behavior, not the software

**Resolution:**
- Memory is portable (SQLite + export)
- Abstract LLM interface even though only Claude Code is supported initially
- Ship fast — accumulated memory IS the moat
- Strategic recommendation accepted: "Ship minimal daemon in 6 weeks"

### M-10: Ubuntu Server is Single Point of Failure

**Source:** Distributed Systems Engineer
- No backup strategy, no disaster recovery
- If Ubuntu server dies, everything stops

**Resolution:**
- Phase 0: automated SQLite backup (daily, to configurable path)
- Document manual disaster recovery procedure
- Future: optional replication to secondary node (post-v1.0)

---

## Low-Priority Findings (Post-v1.0)

| ID | Finding | Source | Resolution |
|---|---|---|---|
| L-1 | No diff-based file editing UI | Cline Comparison | Desktop client Phase 7 |
| L-2 | No @-mention context injection | Cline Comparison | Evaluate for Phase 3 |
| L-3 | No checkpoint/rollback | Cline Comparison | Git-based, Phase 5 |
| L-4 | No design system (colors, icons, motion) | Product Designer | Phase 7 |
| L-5 | No web dashboard auth | Product Designer | Phase 9 |
| L-6 | Calendar/email/smart home integrations | End User | v1.1-1.2 (except HA, see M-3) |
| L-7 | No resampling logic for audio | Voice/Audio | Phase 6 |
| L-8 | Multi-GPU distribution | Performance | v1.1 |
| L-9 | Distributed tracing | Distributed Systems | v1.1 |
| L-10 | Plugin system | Multiple | v2.0 |

---

## Summary of Changes by Document

| Document | Changes |
|---|---|
| **ROADMAP.md** | CI/testing/systemd to Phase 0; realistic timelines; iOS 6 weeks; HA in Phase 4.5 |
| **ARCHITECTURE.md** | 3-database split; event bus persistence; circuit breakers; degradation matrix |
| **MEMORY_ENGINE.md** | ComplEx instead of TransE; multilingual-e5-small; RRF fusion; configurable entity thresholds |
| **SECURITY.md** | Remove --dangerously-skip-permissions; GPU auth; env key isolation; learning sandboxing |
| **GPU_AND_VOICE.md** | Opus codec; faster-whisper; audio preprocessing; WebRTC AEC3; Intl.Segmenter; realistic latency |
| **CLAUDE_INTEGRATION.md** | Abstraction layer; remove process pool pre-warming; remove skip-permissions |
| **CLIENT_ARCHITECTURE.md** | Cloudflare Tunnel option; APNs implementation; realistic iOS timeline |
| **COGNITIVE_LOOP.md** | Backpressure; retry/circuit breakers; event persistence |
| **NEW: TESTING.md** | Full testing strategy; FakeClaudeProcess; golden datasets; CI pipeline |
| **NEW: ACCESSIBILITY.md** | WCAG 2.1 AA target; screen reader; keyboard nav; voice-first a11y |
| **NEW: HOME_AUTOMATION.md** | HA WebSocket API; entity resolution; security policies; use cases |
| **NEW: CODE_OF_CONDUCT.md** | Contributor Covenant v2.1 |
| **NEW: SECURITY.md (root)** | Vulnerability reporting policy |
| **NEW: .github/ templates** | Issue templates; PR template |
| **README.md** | Status disclaimer; doc links for new docs |
| **CLAUDE.md** | Updated to reflect all changes |
