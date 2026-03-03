# Glossary

> Key terms and concepts used throughout the Eidolon project.
> Each definition is kept to 1-2 sentences for quick reference.

---

## Architecture

**Cognitive Loop** -- The continuous perceive-evaluate-act-reflect cycle that drives Eidolon's autonomous behavior. Replaces fixed-interval timers with an event-driven loop that adapts to context.

**PEAR Cycle** -- Perceive, Evaluate, Act, Reflect. The four phases of each cognitive loop iteration. Perceive collects events, Evaluate assigns priority, Act executes the chosen action, Reflect extracts memories and updates state.

**Event Bus** -- A typed publish/subscribe system persisted to SQLite that decouples Eidolon's subsystems. Events survive daemon crashes and are replayed in priority order on restart.

**3-Database Split** -- Eidolon uses three separate SQLite databases to eliminate write contention: `memory.db` (memories, embeddings, KG), `operational.db` (sessions, events, state), and `audit.db` (append-only audit log).

**Gateway** -- The WebSocket server (default port 8419) that clients connect to using JSON-RPC 2.0 protocol. Handles authentication, message routing, and push events.

**MCP (Model Context Protocol)** -- An open protocol for extending LLM capabilities via external tool servers. Eidolon passes configured MCP servers to Claude Code CLI via `--mcp-config`.

**Channel** -- An interface for bidirectional messaging with a user (e.g., Telegram, desktop app, CLI). All channels implement the same `Channel` interface and route messages through the Event Bus.

## Sessions

**Session** -- A managed Claude Code CLI subprocess with a specific purpose and tool whitelist. Each session has its own workspace directory and isolated environment.

**Session Types** -- The six categories of sessions: `main` (user conversation), `task` (scheduled work), `learning` (discovery and implementation), `dream` (memory consolidation), `voice` (TTS/STT pipeline), and `review` (code review).

**Session Supervisor** -- The component that manages concurrent sessions, enforces concurrency limits per type, handles priority-based interruption, and coordinates resource allocation.

## Memory

**Working Memory** -- The active context of the current conversation, held in RAM. Feeds into short-term memory after each turn via the Memory Extractor.

**Short-Term Memory** -- Recently extracted facts, decisions, and preferences stored in SQLite with a configurable TTL (default 90 days). Automatically populated by the Memory Extractor.

**Long-Term Memory** -- Consolidated, verified knowledge promoted from short-term memory during dreaming. Injected into `MEMORY.md` for each Claude Code session.

**Episodic Memory** -- Summaries of past interactions stored with a longer TTL (default 365 days). Provides "last week we discussed..." context.

**Procedural Memory** -- Learned procedures stored as `skills/*.md` files in the workspace. Auto-extracted from repeated action patterns and retired after 90 days of non-use.

**Memory Extractor** -- Runs automatically after every conversation turn to extract structured information (facts, decisions, preferences) without relying on the LLM to voluntarily write memory.

**Memory Injector** -- Selects the top-K most relevant memories via hybrid search and writes them into `MEMORY.md` before each Claude Code session.

## Dreaming

**Dreaming** -- A biologically-inspired memory consolidation process that runs during idle periods (default 02:00). Consists of three phases that clean, connect, and abstract memories.

**Housekeeping (Phase 1)** -- Light-sleep phase that deduplicates memories, resolves contradictions, applies confidence decay, and prunes expired entries. No LLM calls required.

**REM (Phase 2)** -- Associative discovery phase that finds non-obvious connections between memories, creates graph edges, and trains ComplEx embeddings on the Knowledge Graph.

**NREM (Phase 3)** -- Deep-sleep phase that runs community detection on the Knowledge Graph, abstracts general rules from clusters of specific memories, and extracts reusable skills.

## Search and Retrieval

**BM25** -- A probabilistic keyword search algorithm used via SQLite FTS5. Scores documents by term frequency and inverse document frequency. One of the two search methods fused by RRF.

**RRF (Reciprocal Rank Fusion)** -- A parameter-free method for combining ranked results from multiple search methods. Uses the formula `score = sum(1/(k + rank_i))` where k=60, fusing BM25, vector, and graph search results.

**Hybrid Search** -- Eidolon's search strategy that combines BM25 keyword search, vector similarity search (384-dim embeddings), and optional graph-walk expansion, fused via RRF.

## Knowledge Graph

**Knowledge Graph (KG)** -- A structured representation of entities and their typed relationships (subject-predicate-object triples). Extracted from conversations alongside regular memories.

**KG Entity** -- A named object in the Knowledge Graph (person, technology, device, project, concept, or place) with attributes and an importance score derived from PageRank.

**KG Relation** -- A typed connection between two KG entities (e.g., "Manuel uses TypeScript", "Qwen3-TTS runs_on RTX 5080") with a confidence score and provenance tracking.

**ComplEx** -- A knowledge graph embedding method using complex-valued vectors that handles symmetric, antisymmetric, and 1-to-N relations. Trained during REM dreaming for link prediction.

**Community Detection** -- The process of grouping densely connected KG entities into clusters (e.g., "Development Stack", "GPU Infrastructure") using modularity optimization. Runs during NREM dreaming.

## Resource Management

**Energy Budget** -- A per-hour token allocation system that prevents runaway API costs. Tokens are budgeted across categories (user 50%, tasks 20%, learning 20%, dreaming 10%), and user messages always bypass the budget.

**Circuit Breaker** -- A resilience pattern that prevents cascading failures when external services (Claude API, GPU worker, Telegram) are down. Transitions through closed, open, and half-open states.

**Account Rotation** -- The system for selecting the best Claude account for each request based on priority, remaining quota, and cooldown status. Automatically fails over when an account is rate-limited.

## Self-Learning

**Discovery** -- The process of crawling configured sources (Reddit, HN, GitHub, RSS) during idle periods to find potentially relevant content.

**Relevance Filter** -- An LLM-scored evaluation (using a cheap model) that rates discovered content 0-100 against user interests and system interests. Content below the threshold (default 60) is discarded.

**Safety Classification** -- Every actionable discovery is classified as `safe` (store as knowledge), `needs_approval` (ask user before acting), or `dangerous` (block and log). Code changes are never classified as safe.

**Implementation Pipeline** -- The workflow for turning approved discoveries into code changes: create git worktree, spawn Claude Code session, auto-lint, auto-test, report results.

## Claude Code Integration

**IClaudeProcess** -- The abstraction interface for Claude Code CLI interaction. Production code uses `ClaudeCodeManager`; tests use `FakeClaudeProcess`. All code depends on the interface, never on the concrete implementation.

**FakeClaudeProcess** -- A test double implementing `IClaudeProcess` that returns configurable responses without spawning real CLI processes or making API calls. Supports regex-based prompt matching.

**Workspace Preparer** -- Creates a temporary workspace directory for each session and injects context files (`CLAUDE.md`, `MEMORY.md`, `SOUL.md`) before spawning Claude Code CLI.

**StreamEvent** -- The typed events yielded by parsing Claude Code CLI's streaming JSON output: `text`, `tool_use`, `tool_result`, `error`, `done`, and `system`.

## Voice and GPU

**GPU Worker** -- A Python/FastAPI service running on a machine with a GPU that provides TTS (Qwen3-TTS) and STT (faster-whisper) endpoints. Communicates with Core over Tailscale.

**Voice Pipeline** -- The streaming voice system that chunks Claude's response into sentences (using `Intl.Segmenter`), dispatches each to TTS independently, and supports barge-in interruption.

**TTS Fallback Chain** -- The degradation strategy when GPU is unavailable: Qwen3-TTS (GPU) -> Kitten TTS (CPU) -> System TTS (OS built-in) -> text-only mode.

## Coding Patterns

**Result Pattern** -- The error handling convention used throughout Eidolon: `{ ok: true; value: T } | { ok: false; error: E }`. Used for all expected failures; `throw` is reserved for programming bugs only.

**Zod Schema** -- Runtime type validation using the Zod library, applied at all external data boundaries (config files, API responses, IPC messages, WebSocket payloads).

---

*See also: [Architecture](design/ARCHITECTURE.md), [Cognitive Loop](design/COGNITIVE_LOOP.md), [Memory Engine](design/MEMORY_ENGINE.md), [Configuration Reference](reference/CONFIGURATION.md).*
