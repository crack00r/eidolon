# Eidolon Master Task List

> **Vision**: Eigenes, vollstaendiges System -- ein besseres OpenClaw.
> Eidolon is a complete, standalone personal AI assistant. Not an MCP server, not infrastructure, not a library.
>
> **Generated**: 2026-03-06 from exhaustive codebase scan (98,322 source lines, 117 test files, 1,810 test() calls).
> **Current state**: 1,774 tests passing, 0 type errors, 4 lint warnings, 6 skipped embedding tests.

## Legend

- **Priority**: P0 (blocks v1.0 launch) | P1 (should fix before v1.0) | P2 (important but deferrable) | P3 (nice to have)
- **Effort**: S (hours) | M (1-2 days) | L (3-5 days) | XL (1+ week)

---

## 1. Production Readiness & Core Wiring

These are the tasks that make the daemon actually work end-to-end as a real system.

### P0-01: Decompose daemon/index.ts god object (2,541 lines)
- **Priority**: P0 | **Effort**: L
- The daemon orchestrator is 8.5x over the 300-line limit. Contains module initialization, event handling, shutdown logic, and loop wiring all in one file. Must split into: `daemon/initializer.ts` (module init order), `daemon/event-handlers.ts` (cognitive loop handlers), `daemon/shutdown.ts` (graceful shutdown), `daemon/lifecycle.ts` (PID, signals).
- **Dependencies**: None
- **Risk**: High-touch refactor across the central nervous system of the project.

### P0-02: Wire KG entities and relations into MemoryInjector
- **Priority**: P0 | **Effort**: M
- Lines 837-838 of daemon/index.ts pass `null` for KG entities and KG relations. The Knowledge Graph data never reaches MEMORY.md context injection. This means Claude never sees relationship data during sessions.
- **Dependencies**: KG modules exist and are tested.

### P0-03: Wire REM dreaming LLM calls (analyzeFn)
- **Priority**: P0 | **Effort**: M
- `memory/dreaming/rem.ts` line 147: "LLM analysis (stubbed)". The `AnalyzeConnectionsFn` interface is defined but never connected to Claude or any LLM provider. REM dreaming discovers connections via cosine similarity but cannot find non-obvious associations.
- **Dependencies**: ILLMProvider or ClaudeCodeManager available in dreaming context.

### P0-04: Wire NREM dreaming LLM calls (AbstractRuleFn)
- **Priority**: P0 | **Effort**: M
- `memory/dreaming/nrem.ts` line 2: "uses LLM (stubbed for now)". The `AbstractRuleFn` interface is defined but never connected. NREM cannot abstract rules from memory clusters without an LLM.
- **Dependencies**: Same as P0-03.

### P0-05: Implement HTTP crawling in self-learning discovery
- **Priority**: P0 | **Effort**: L
- `learning/discovery.ts` (382 lines) has CRUD for discoveries, URL validation, deduplication, and budget tracking, but ZERO HTTP fetching code. Cannot crawl Reddit, HN, GitHub, RSS, or any source. The DiscoveryEngine is a database layer without a data source.
- **Dependencies**: None. Design references exist in `docs/design/SELF_LEARNING.md`.

### P0-06: Wire Voice STT pipeline in daemon
- **Priority**: P0 | **Effort**: M
- Daemon line 1949: "Voice input received without transcription -- STT not wired yet". When voice audio arrives, the daemon logs a warning and does nothing. The GPU STT client exists (`gpu/stt-client.ts`, 124 lines) but is not connected to the voice event handler.
- **Dependencies**: GPU worker running with STT endpoint.

### P0-07: Implement core gateway methods (chat.send, chat.stream, memory.search, etc.)
- **Priority**: P0 | **Effort**: XL
- The gateway server handles JSON-RPC routing but is missing implementations for ~20 core methods defined in the protocol type. Missing: `chat.send`, `chat.stream`, `memory.search`, `memory.delete`, `session.list`, `session.info`, `learning.list`, `learning.approve`, `learning.reject`, `voice.start`, `voice.stop`, `feedback.submit`, `feedback.list`, `brain.getLog`, `brain.triggerAction`, `metrics.rateLimits`, `llm.complete`.
- **Dependencies**: Respective core modules must be initialized.

### P0-08: Wire Discord channel in daemon
- **Priority**: P1 | **Effort**: M
- Discord channel code exists (403 lines) with injectable IDiscordClient, but daemon line 1031-1037 logs a warning and skips it. The channel is imported but never actually connected.
- **Dependencies**: discord.js or equivalent adapter.

### P0-09: Replace OpenAI compat stub responses
- **Priority**: P1 | **Effort**: M
- `gateway/openai-compat.ts` lines 166, 195 return "This is a stub response" for both streaming and non-streaming. The /v1/chat/completions endpoint exists but does not route to Claude.
- **Dependencies**: ClaudeCodeManager or ILLMProvider.

### P0-10: Wire ConfigWatcher in daemon for hot-reload
- **Priority**: P1 | **Effort**: S
- `config/watcher.ts` (166 lines) is fully implemented with file watching and security checks, but is never instantiated in the daemon. Config changes require full daemon restart.
- **Dependencies**: None.

### P0-11: Wire DocumentIndexer in daemon
- **Priority**: P1 | **Effort**: M
- `memory/document-indexer.ts` (577 lines) is fully implemented with markdown/text/PDF/code chunking, but is never instantiated in the daemon. Personal document search is unavailable at runtime.
- **Dependencies**: MemoryStore, EmbeddingModel.

### P0-12: Wire ResearchEngine in daemon
- **Priority**: P1 | **Effort**: M
- `research/engine.ts` (517 lines) exists with full implementation and tests, but the daemon never imports or initializes it. Gateway has `research.start/status/list` handlers but they need the engine.
- **Dependencies**: ILLMProvider or ClaudeCodeManager.

### P0-13: Wire Profile system in daemon
- **Priority**: P2 | **Effort**: S
- `memory/profile.ts`, `profile-queries.ts`, `profile-formatter.ts` (~355 lines total) exist with tests, but the daemon never initializes them. The `profile.get` gateway handler exists but needs the profile module.
- **Dependencies**: MemoryStore.

### P0-14: Wire Feedback system in daemon
- **Priority**: P2 | **Effort**: S
- `feedback/` module (3 source files, ~250 lines) with confidence scoring, gateway handlers, and store exists but daemon never initializes it. Gateway `feedback.submit`/`feedback.list` are defined but not registered.
- **Dependencies**: DatabaseManager.

### P0-15: Wire user:approval handler to ApprovalManager
- **Priority**: P1 | **Effort**: S
- Daemon line 867-869: `user:approval` event handler just logs "User approval received" and returns success without actually routing to the ApprovalManager (515 lines, fully tested). Approvals never complete.
- **Dependencies**: ApprovalManager initialized.

### P0-16: Wire scheduler:task_due handler to actual execution
- **Priority**: P1 | **Effort**: M
- Daemon line 871-878: `scheduler:task_due` handler logs the task and returns success without executing anything. Scheduled tasks never run.
- **Dependencies**: ClaudeCodeManager or relevant executor.

### P0-17: Fix CI lint failure on main branch
- **Priority**: P0 | **Effort**: S
- 4 Biome lint warnings in core: unused private fields in `caldav.ts`, `google.ts`, `channel.ts` (WhatsApp). These are warnings not errors, but CI may fail on stricter settings.
- **Dependencies**: None.

---

## 2. Memory Engine Completion

### P0-18: Wire ComplEx training to actual KG data in daemon
- **Priority**: P1 | **Effort**: M
- ComplEx embeddings module (396 lines) is fully implemented and tested, but never receives real KG triples from the daemon. Training only happens if explicitly called.
- **Dependencies**: KG entities/relations wired (P0-02).

### P0-19: Wire Louvain community detection in daemon
- **Priority**: P1 | **Effort**: M
- `knowledge-graph/communities.ts` (518 lines) has full Louvain algorithm and community summarization, but is never called from the dreaming pipeline or daemon.
- **Dependencies**: KG entities/relations, LLM for summaries.

### P1-01: Create search relevance golden dataset
- **Priority**: P2 | **Effort**: M
- Design doc specifies "30+ queries with expected memory rankings". Extraction golden dataset exists (105 entries) but search relevance dataset is missing entirely.
- **Dependencies**: None.

### P1-02: Implement PageRank for entity importance
- **Priority**: P2 | **Effort**: M
- Design doc (MEMORY_ENGINE.md) describes PageRank over KG relations for entity importance scoring. The `kg_entities` table has an `importance` field but no code updates it.
- **Dependencies**: KG relations populated.

### P1-03: Memory compression deduplication in consolidation
- **Priority**: P2 | **Effort**: S
- `memory/consolidation.ts` (434 lines) and `memory/compression.ts` exist, but the deduplication strategy for very similar memories during consolidation may not use the embedding similarity threshold correctly for all memory types.
- **Dependencies**: EmbeddingModel.

---

## 3. Cognitive Loop & Autonomy

### P1-04: Implement adaptive rest duration based on user activity
- **Priority**: P2 | **Effort**: S
- `loop/rest.ts` (109 lines) exists but verify it's wired to actual user activity timestamps from channels, not just loop cycle times.
- **Dependencies**: Channel message timestamps.

### P1-05: Verify energy budget enforcement under load
- **Priority**: P1 | **Effort**: M
- `loop/energy-budget.ts` (151 lines) exists and is used in the cognitive loop, but has never been tested under sustained real-world token consumption. Edge cases: budget reset timing, category overspend, user override.
- **Dependencies**: Token tracker integration.

### P1-06: Implement session interruption for priority override
- **Priority**: P1 | **Effort**: M
- Design doc says lower-priority sessions should be paused when higher-priority events arrive. SessionSupervisor exists but verify the pause/resume mechanism actually interrupts Claude Code subprocesses.
- **Dependencies**: ClaudeCodeManager abort() implementation.

### P1-07: Backpressure testing under event flood
- **Priority**: P2 | **Effort**: M
- EventBus has backpressure logic (drop low-priority when queue exceeds threshold) but it's never been tested under realistic event flood conditions.
- **Dependencies**: None.

---

## 4. Channel Integration

### P1-08: End-to-end Telegram message flow test
- **Priority**: P1 | **Effort**: M
- Telegram channel (472 lines) has unit tests with mocked grammy bot, but no integration test verifying the full flow: Telegram message -> EventBus -> CognitiveLoop -> Claude -> response -> Telegram.
- **Dependencies**: FakeClaudeProcess, in-memory databases.

### P1-09: End-to-end WhatsApp message flow test
- **Priority**: P2 | **Effort**: M
- WhatsApp channel is implemented (channel.ts + api.ts + webhook.ts, ~1,126 lines) with unit tests, but no integration test covering the webhook -> EventBus -> response -> API flow.
- **Dependencies**: Same as P1-08.

### P1-10: End-to-end Email channel flow test
- **Priority**: P2 | **Effort**: M
- Email channel (channel.ts 590 lines + imap.ts 385 lines + parser/formatter, ~1,899 lines total) with unit tests, but no integration test covering IMAP poll -> parse -> EventBus -> response -> SMTP send.
- **Dependencies**: Same as P1-08.

### P1-11: Implement CLI `eidolon channel telegram status`
- **Priority**: P2 | **Effort**: S
- `cli/commands/channel.ts` line 13: "Not yet implemented -- Phase 4". The channel status command is a stub.
- **Dependencies**: Daemon gateway connection from CLI.

---

## 5. Self-Learning Pipeline

### P0-20: Implement source crawlers (Reddit, HN, GitHub, RSS)
- **Priority**: P0 | **Effort**: XL
- Part of P0-05 but broken out for clarity. Need individual crawlers for each source type. Reddit: API or Playwright. HN: Firebase API. GitHub: trending scraping. RSS: standard parser. Each needs rate limiting, error handling, content sanitization.
- **Dependencies**: P0-05 (discovery HTTP framework).

### P1-12: Implement relevance filter with LLM scoring
- **Priority**: P1 | **Effort**: M
- `learning/relevance.ts` exists but verify it actually calls an LLM to score content relevance, not just a rule-based filter.
- **Dependencies**: ILLMProvider.

### P1-13: Implement safety classifier for discoveries
- **Priority**: P1 | **Effort**: M
- `learning/safety.ts` exists but verify the classification logic: code changes must NEVER be "safe" (always "needs_approval").
- **Dependencies**: None.

### P1-14: Implement git worktree implementation pipeline
- **Priority**: P1 | **Effort**: L
- Design doc describes: create worktree -> spawn Claude Code -> auto-lint -> auto-test -> notify user. Verify `learning/implementation.ts` covers all steps including branch cleanup.
- **Dependencies**: ClaudeCodeManager, git.

### P1-15: Wire learning journal entry generation
- **Priority**: P2 | **Effort**: S
- `learning/journal.ts` exists but verify it creates daily markdown journal entries in `~/.eidolon/journal/`.
- **Dependencies**: Discovery pipeline.

### P1-16: Implement CLI `eidolon learning approve <id>`
- **Priority**: P1 | **Effort**: M
- `cli/commands/learning.ts` (503 lines) exists. Verify the approve command actually routes through the daemon gateway to update discovery status and trigger implementation.
- **Dependencies**: Gateway `learning.approve` handler (P0-07).

---

## 6. Voice & GPU Pipeline

### P1-17: Wire GPU worker TTS into response pipeline
- **Priority**: P1 | **Effort**: M
- GPUManager is initialized in daemon (line 1258+) when workers are configured, but verify that text responses are actually sent to TTS and audio is returned to the requesting channel.
- **Dependencies**: GPU worker running.

### P1-18: Implement sentence-level TTS chunking with Intl.Segmenter
- **Priority**: P2 | **Effort**: S
- `gpu/voice-pipeline.ts` (143 lines) exists. Verify it uses `Intl.Segmenter` for sentence detection (not regex) as specified in the design doc.
- **Dependencies**: None.

### P1-19: Implement TTS fallback chain (Qwen3 -> Kitten -> System -> text)
- **Priority**: P2 | **Effort**: M
- `gpu/fallback.ts` (87 lines) exists. Verify the full fallback chain works when GPU worker is offline.
- **Dependencies**: None.

### P1-20: Voice state machine implementation
- **Priority**: P2 | **Effort**: M
- Design doc specifies idle/listening/processing/speaking/interrupted states. Verify the state machine in the realtime client handles all transitions including barge-in.
- **Dependencies**: GPU worker.

### P1-21: Realtime voice WebSocket protocol
- **Priority**: P2 | **Effort**: L
- `gpu/realtime-client.ts` (461 lines) exists with tests. Verify Opus codec encoding, jitter buffer, and echo cancellation strategy match the design doc.
- **Dependencies**: GPU worker with `/voice/realtime` endpoint.

---

## 7. Security & Privacy

### P0-21: Add test coverage for privacy/consent.ts
- **Priority**: P0 | **Effort**: M
- `privacy/consent.ts` (153 lines) handles GDPR consent management -- ZERO test coverage. This is legally critical functionality.
- **Dependencies**: None.

### P0-22: Add test coverage for privacy/retention.ts
- **Priority**: P0 | **Effort**: M
- `privacy/retention.ts` (182 lines) handles data retention policies and cascading deletion -- ZERO test coverage. A bug here could violate GDPR.
- **Dependencies**: None.

### P0-23: Add test coverage for audit/logger.ts
- **Priority**: P1 | **Effort**: M
- `audit/logger.ts` (241 lines) handles the append-only audit trail -- ZERO test coverage. Audit integrity is a security requirement.
- **Dependencies**: None.

### P1-22: Verify GDPR cascading delete in `eidolon privacy forget`
- **Priority**: P1 | **Effort**: M
- `cli/commands/privacy.ts` (679 lines) implements forget/export/consent. Verify cascading delete removes data from: memories, kg_entities, kg_relations, memory_edges, audit entries, and regenerates MEMORY.md.
- **Dependencies**: P0-21, P0-22.

### P1-23: Verify API key isolation in subprocess environment
- **Priority**: P1 | **Effort**: S
- Design doc (SECURITY.md) specifies API keys should ONLY exist in subprocess env, never in parent. Verify `claude/manager.ts` (242 lines) implements this correctly.
- **Dependencies**: None.

### P1-24: Verify content sanitization in learning pipeline
- **Priority**: P1 | **Effort**: S
- Self-learning design specifies content sanitization before LLM evaluation to prevent prompt injection. Verify `email/parser.ts` line 258 and learning pipeline have adequate sanitization.
- **Dependencies**: None.

### P1-25: Verify action classification for HA critical devices
- **Priority**: P2 | **Effort**: S
- `home-automation/policies.ts` (123 lines) should classify locks/alarms as `needs_approval` per design doc. Verify policy enforcement.
- **Dependencies**: None.

---

## 8. Code Quality & Architecture

### P1-26: Decompose gateway/server.ts (1,632 lines)
- **Priority**: P1 | **Effort**: L
- 5.4x over the 300-line limit. Should split into: `server-core.ts` (lifecycle, TLS, HTTP routing), `server-ws.ts` (WebSocket handling, auth), `server-rpc.ts` (JSON-RPC dispatch), `server-health.ts` (health endpoint).
- **Dependencies**: None.

### P1-27: Fix 4 Biome lint warnings (unused private fields)
- **Priority**: P1 | **Effort**: S
- Unused `config` fields in: `calendar/providers/caldav.ts`, `calendar/providers/google.ts`, `channels/whatsapp/channel.ts`. Plus 2 infos. Trivial fix.
- **Dependencies**: None.

### P1-28: Split memory/store.ts (639 lines)
- **Priority**: P2 | **Effort**: M
- 2.1x over limit. Separate CRUD operations from FTS sync triggers and batch operations.
- **Dependencies**: None.

### P1-29: Split memory/document-indexer.ts (577 lines)
- **Priority**: P2 | **Effort**: M
- 1.9x over limit. Separate chunking strategies (markdown, PDF, code, plaintext) into individual files.
- **Dependencies**: None.

### P1-30: Split memory/extractor.ts (545 lines)
- **Priority**: P2 | **Effort**: M
- 1.8x over limit. Separate rule-based extraction from LLM extraction and consolidation logic.
- **Dependencies**: None.

### P1-31: Split channels/email/channel.ts (590 lines)
- **Priority**: P2 | **Effort**: M
- 2x over limit. Separate IMAP polling, SMTP sending, and message formatting.
- **Dependencies**: None.

### P1-32: Split calendar/manager.ts (527 lines)
- **Priority**: P2 | **Effort**: S
- 1.8x over limit. Separate provider management from event storage and sync logic.
- **Dependencies**: None.

### P1-33: Split knowledge-graph/communities.ts (518 lines)
- **Priority**: P2 | **Effort**: S
- 1.7x over limit. Separate Louvain algorithm from community summarization and PageRank.
- **Dependencies**: None.

### P1-34: Split security/approval-manager.ts (515 lines)
- **Priority**: P2 | **Effort**: S
- 1.7x over limit. Separate approval storage from timeout/notification logic.
- **Dependencies**: None.

### P1-35: Split research/engine.ts (517 lines)
- **Priority**: P2 | **Effort**: S
- 1.7x over limit. Separate search execution from result formatting and persistence.
- **Dependencies**: None.

### P1-36: Split loop/event-bus.ts (510 lines)
- **Priority**: P2 | **Effort**: S
- 1.7x over limit. Separate persistence layer from pub/sub dispatch and backpressure.
- **Dependencies**: None.

### P1-37: Split cli/commands/learning.ts (503 lines)
- **Priority**: P2 | **Effort**: S
- 1.7x over limit. Separate subcommands into individual handler functions.
- **Dependencies**: None.

### P1-38: Split cli/commands/onboard.ts (486 lines)
- **Priority**: P3 | **Effort**: S
- 1.6x over limit. Already partially split with `onboard-steps.ts` (369 lines).
- **Dependencies**: None.

### P1-39: Split knowledge-graph/entities.ts (491 lines)
- **Priority**: P3 | **Effort**: S
- 1.6x over limit.
- **Dependencies**: None.

### P1-40: Split gpu/realtime-client.ts (461 lines)
- **Priority**: P3 | **Effort**: S
- 1.5x over limit.
- **Dependencies**: None.

### P1-41: Split cli/commands/memory.ts (447 lines)
- **Priority**: P3 | **Effort**: S
- 1.5x over limit.
- **Dependencies**: None.

### P1-42: protocol/config.ts at 685 lines
- **Priority**: P3 | **Effort**: M
- 2.3x over limit. Could split into `config-brain.ts`, `config-channels.ts`, `config-gpu.ts`, etc. However, having all Zod schemas in one file aids discoverability. Consider whether splitting is net-positive.
- **Dependencies**: Many files import from config.ts.

### P2-01: Consolidate error handling patterns
- **Priority**: P3 | **Effort**: S
- Some modules use `catch (err: unknown)`, others `catch (cause)`. Standardize on one pattern across the codebase.
- **Dependencies**: None.

### P2-02: Remove `console.log`/`console.error` in CLI privacy commands
- **Priority**: P3 | **Effort**: S
- `cli/commands/privacy.ts` uses `console.log`/`console.error` directly (~20 instances). Should use the CLI formatter utilities for consistent output.
- **Dependencies**: None.

### P2-03: Create workspace/ template directory with SOUL.md
- **Priority**: P2 | **Effort**: S
- IMPLEMENTATION_PLAN.md specifies `workspace/SOUL.md` and `workspace/CLAUDE.md` templates. The directory doesn't exist. WorkspacePreparer accepts soulMd as optional content but has no default template.
- **Dependencies**: None.

---

## 9. Testing & Reliability

### P0-24: Add end-to-end daemon integration test
- **Priority**: P0 | **Effort**: L
- Only one integration test exists: `daemon-memory-integration.test.ts` (520 lines). Need a full E2E test: daemon start -> message via gateway -> Claude (FakeClaudeProcess) -> response -> memory extraction -> verify in database.
- **Dependencies**: FakeClaudeProcess, in-memory databases.

### P0-25: Test circuit breakers under real failure patterns
- **Priority**: P1 | **Effort**: M
- Circuit breaker unit tests exist in `health/circuit-breaker.test.ts` but never tested with actual service failures (Claude API timeout, GPU worker offline, Telegram API error).
- **Dependencies**: FakeClaudeProcess with configurable failures.

### P1-43: Test backup and restore cycle
- **Priority**: P1 | **Effort**: M
- BackupManager has `runBackup()` and `decryptBackupFile()` but no test verifying the full cycle: backup -> corrupt source -> restore from backup -> verify data integrity.
- **Dependencies**: None.

### P1-44: Add tests for gateway/server.ts
- **Priority**: P1 | **Effort**: L
- `gateway/server.ts` (1,632 lines) has related tests in `gateway/__tests__/gateway.test.ts` (1,220 lines) but these may not cover TLS, rate limiting, auth edge cases, and the many handler registrations.
- **Dependencies**: None.

### P1-45: Add tests for channels/telegram/channel.ts
- **Priority**: P1 | **Effort**: M
- Telegram channel (472 lines) has no dedicated `channel.test.ts`. Channel-level tests exist in `channels/__tests__/router.test.ts` (989 lines) but may not cover Telegram-specific logic.
- **Dependencies**: None.

### P1-46: Add tests for scheduler/automation.ts
- **Priority**: P2 | **Effort**: M
- `scheduler/automation.ts` (424 lines) has no dedicated test file. Automation parsing and cron generation are complex enough to warrant thorough testing.
- **Dependencies**: None.

### P1-47: Add tests for digest/builder.ts
- **Priority**: P2 | **Effort**: S
- `digest/builder.ts` (424 lines) has digest generation tests in `digest/__tests__/` but verify coverage of edge cases (empty data, missing modules).
- **Dependencies**: None.

### P1-48: Add tests for gpu/worker.ts and gpu/manager.ts
- **Priority**: P2 | **Effort**: M
- `gpu/worker.ts` (321 lines) and `gpu/manager.ts` (251 lines) have no dedicated test files. GPU pool and balancer tests exist but may not cover worker discovery and health monitoring.
- **Dependencies**: None.

### P1-49: Add tests for config/watcher.ts (hot-reload)
- **Priority**: P2 | **Effort**: S
- `config/watcher.ts` (166 lines) has no test file. Hot-reload with security checks (file permission validation) needs testing.
- **Dependencies**: None.

### P1-50: Add tests for gateway/rate-limiter.ts
- **Priority**: P2 | **Effort**: S
- `gateway/rate-limiter.ts` (242 lines) has no dedicated test file. Rate limiting logic (exponential backoff on auth failures) is security-critical.
- **Dependencies**: None.

### P1-51: Add tests for gateway/cert-manager.ts
- **Priority**: P2 | **Effort**: S
- `gateway/cert-manager.ts` (158 lines) has no dedicated test file. TLS certificate handling needs testing.
- **Dependencies**: None.

### P1-52: Test plugin lifecycle and sandbox
- **Priority**: P2 | **Effort**: M
- `plugins/lifecycle.ts` (129 lines) and `plugins/sandbox.ts` (85 lines) have tests at `__tests__/plugins.test.ts` (595 lines) but verify sandbox permission enforcement.
- **Dependencies**: None.

### P1-53: Add load/stress testing framework
- **Priority**: P2 | **Effort**: L
- No load testing exists. Need to verify: concurrent WebSocket connections, event bus throughput, database write contention under load, memory usage over time.
- **Dependencies**: None.

### P1-54: Add chaos testing for resilience patterns
- **Priority**: P2 | **Effort**: L
- No chaos tests. Need: random service failures, network partitions, disk full scenarios, OOM conditions. Verify graceful degradation matrix from ARCHITECTURE.md.
- **Dependencies**: P0-25.

### P2-04: Run embedding tests in CI (currently behind RUN_SLOW flag)
- **Priority**: P3 | **Effort**: S
- 6 embedding tests are skipped in CI behind `RUN_SLOW` env var. Consider running them in a separate CI job or nightly build.
- **Dependencies**: Model download in CI.

### P2-05: Increase golden dataset coverage
- **Priority**: P3 | **Effort**: M
- Extraction golden dataset has 105 entries (up from 3). Design doc targets 50+ with German and English. Verify German coverage and add more edge cases.
- **Dependencies**: None.

---

## 10. CLI & User Experience

### P1-55: Implement CLI `eidolon plugin` commands
- **Priority**: P1 | **Effort**: M
- `cli/commands/plugin.ts`: all 6 subcommands (list, info, install, uninstall, enable, disable) print "Not yet implemented". Plugin system exists in core but CLI doesn't connect to it.
- **Dependencies**: Gateway plugin handlers.

### P1-56: Implement CLI `eidolon llm` commands
- **Priority**: P1 | **Effort**: S
- `cli/commands/llm.ts`: all 3 subcommands (providers, models, complete) print "Not yet implemented". LLM system exists in core.
- **Dependencies**: Gateway LLM handlers (partially exist).

### P1-57: Fix README test count (claims 522, actual 1,774)
- **Priority**: P1 | **Effort**: S
- README badge shows "522 passing" but actual count is 1,774 (1,538 core + 112 cli + 92 protocol + 24 test-utils + 8 skipped). Significantly understates test coverage.
- **Dependencies**: None.

### P1-58: Publish @eidolon-ai/cli to npm
- **Priority**: P1 | **Effort**: M
- CLI package has never been published to npm (404 from registry). The `release-cli.yml` workflow exists but has never successfully run. Need: verify package.json `name`, `bin` field, npm token in secrets, test publish.
- **Dependencies**: CI passing.

### P1-59: Create INSTALLATION.md guide
- **Priority**: P2 | **Effort**: M
- Setup guides exist (`docs/setup/`, `docs/guides/`) but no single comprehensive installation guide. Phase 9 deliverable: "A new user can follow the installation guide... within 30 minutes."
- **Dependencies**: None.

### P1-60: Verify `eidolon onboard` wizard completeness
- **Priority**: P2 | **Effort**: M
- Onboard command (486 + 369 = 855 lines) exists. Verify all setup steps work: Claude auth, Telegram bot, secret store, database creation, config generation.
- **Dependencies**: None.

---

## 11. Documentation

### P1-61: Update ROADMAP.md with accurate status
- **Priority**: P2 | **Effort**: S
- Roadmap says "v0.1.4 released" but version is 0.1.6. Several sections reference outdated states.
- **Dependencies**: None.

### P1-62: Update CONFIGURATION.md for new config sections
- **Priority**: P2 | **Effort**: M
- Config reference documents the original schema but may be missing sections added later: `privacy`, `digest`, `telemetry`, `plugins`, `llm`, `homeAutomation`, `discord`, `whatsapp`, `email`.
- **Dependencies**: None.

### P1-63: Document gateway API methods
- **Priority**: P2 | **Effort**: M
- No API reference for the ~50 gateway methods. Desktop, iOS, and web apps need to know available methods, parameters, and responses.
- **Dependencies**: None.

### P1-64: Document deployment for all platforms
- **Priority**: P2 | **Effort**: M
- Deploy directory has systemd, launchd, Windows service files. Need verification that instructions work end-to-end on each platform.
- **Dependencies**: None.

### P1-65: Create architecture diagram for current state
- **Priority**: P3 | **Effort**: S
- `ARCHITECTURE.md` diagrams reflect the original design. The actual implementation has more modules (calendar, HA, plugins, LLM, telemetry, etc.) that aren't shown.
- **Dependencies**: None.

---

## 12. Technology Upgrades

### P2-06: Evaluate nomic-embed-text-v1.5 (768-dim) vs multilingual-e5-small (384-dim)
- **Priority**: P2 | **Effort**: L
- Current embedding model is multilingual-e5-small (384-dim). nomic-embed-text-v1.5 offers better quality at 768-dim with Matryoshka support (can truncate to 384-dim for compatibility). Benchmark on golden dataset before switching.
- **Dependencies**: P1-01 (search relevance golden dataset).

### P2-07: Evaluate Graphiti for temporal knowledge graphs
- **Priority**: P3 | **Effort**: M
- Current KG is static (no temporal dimension). Graphiti adds time-awareness to knowledge graphs. Evaluate if temporal relations improve memory retrieval quality.
- **Dependencies**: KG fully wired (P0-02).

### P2-08: Evaluate Qwen3-8B for local extraction/filtering
- **Priority**: P3 | **Effort**: L
- Currently dreaming and extraction use Claude (expensive). A local 8B model could handle extraction, relevance filtering, and dreaming at zero marginal cost. Requires: benchmark quality, verify fits in VRAM alongside TTS/STT.
- **Dependencies**: ILLMProvider architecture (exists).

### P2-09: Evaluate Bun.serve() improvements for gateway
- **Priority**: P3 | **Effort**: S
- Newer Bun versions may offer WebSocket improvements. Check if any gateway code can be simplified.
- **Dependencies**: None.

---

## 13. Infrastructure & DevOps

### P1-66: Verify CI pipeline runs all tests
- **Priority**: P1 | **Effort**: S
- CI workflow runs `pnpm -r test` but CLI tests are split across 5 sequential `bun test` calls (not `bun test src/`). Verify all tests actually execute in CI.
- **Dependencies**: None.

### P1-67: Add Docker Compose for development
- **Priority**: P2 | **Effort**: M
- GPU worker has `Dockerfile.cuda` and `docker-compose.yml` mentioned in design but verify they exist and work. Add a `docker-compose.dev.yml` for local development with all services.
- **Dependencies**: None.

### P1-68: Verify systemd service file works
- **Priority**: P2 | **Effort**: S
- `deploy/eidolon.service` exists (903 bytes). Verify on actual Ubuntu server: service starts, stops, restarts on failure, logs to journal.
- **Dependencies**: Built CLI binary.

### P1-69: Verify launchd plist works
- **Priority**: P2 | **Effort**: S
- `deploy/com.eidolon.daemon.plist` exists. Verify on macOS: launchctl load/unload, auto-start on boot.
- **Dependencies**: Built CLI binary.

### P1-70: Verify Windows service works
- **Priority**: P3 | **Effort**: S
- `deploy/eidolon-windows.ps1` exists. Verify on Windows: service install, start, stop.
- **Dependencies**: Built CLI binary.

### P1-71: Add release workflow for npm publish
- **Priority**: P1 | **Effort**: S
- `release.yml` exists but verify it handles npm publish for `@eidolon-ai/cli`. May need separate step or workflow for npm.
- **Dependencies**: npm token in GitHub secrets.

---

## 14. Client Apps

### P2-10: Verify Tauri desktop app builds and connects
- **Priority**: P2 | **Effort**: M
- `apps/desktop/` has 18 source files. Verify: builds for macOS/Windows/Linux, connects to gateway via WebSocket, chat works, memory browser works.
- **Dependencies**: Gateway running.

### P2-11: Verify iOS app builds and connects
- **Priority**: P2 | **Effort**: M
- `apps/ios/` has 24 Swift files. Verify: builds in Xcode, connects to gateway, chat works, push notifications configured.
- **Dependencies**: Gateway running, APNs configured.

### P2-12: Verify web dashboard functionality
- **Priority**: P2 | **Effort**: M
- `apps/web/` has 32 source files. Verify: all 6 routes work, stores connect to gateway, real-time updates function.
- **Dependencies**: Gateway running.

### P2-13: Desktop app accessibility (WCAG 2.1 AA)
- **Priority**: P3 | **Effort**: M
- Roadmap claims "Keyboard navigation and screen reader support (WCAG 2.1 AA)". Verify in Tauri desktop app.
- **Dependencies**: P2-10.

### P2-14: iOS VoiceOver accessibility
- **Priority**: P3 | **Effort**: M
- Roadmap claims "VoiceOver accessibility support". Verify in iOS app.
- **Dependencies**: P2-11.

---

## 15. Minor & Cleanup Tasks

### P3-01: Remove "critical" from GatewayMethod type
- **Priority**: P3 | **Effort**: S
- The comm comparison showed "critical" as a method -- this is likely a parsing artifact from the type definition (notification priority enum, not a method). Verify and clean up if it's polluting the type.
- **Dependencies**: None.

### P3-02: Clean up `as never` type casts in daemon gateway wiring
- **Priority**: P3 | **Effort**: S
- Daemon lines 1602-1616 use `as never` casts when registering plugin/llm gateway handlers. This suggests a type mismatch that should be fixed properly.
- **Dependencies**: None.

### P3-03: Standardize CLI test runner
- **Priority**: P3 | **Effort**: S
- CLI package.json runs 5 separate `bun test` commands instead of `bun test src/`. This is slower and may miss new test files.
- **Dependencies**: None.

### P3-04: Add CSP reporting endpoint (web dashboard)
- **Priority**: P3 | **Effort**: S
- `apps/web/src/hooks.server.ts` line 17: "TODO: In production, add a report-to directive pointing at a CSP". Security best practice for the web dashboard.
- **Dependencies**: None.

### P3-05: Remove unused imports in apps/desktop and apps/web
- **Priority**: P3 | **Effort**: S
- Both desktop and web apps have duplicate `MAX_RECONNECT_ATTEMPTS` and similar patterns. Verify no dead code.
- **Dependencies**: None.

### P3-06: Verify GPU worker Python tests exist
- **Priority**: P3 | **Effort**: M
- `services/gpu-worker/src/` has 8 Python files. Unclear if any Python tests exist. TTS/STT endpoints need at least smoke tests.
- **Dependencies**: GPU worker environment.

---

## Summary

| Priority | Count | Key Theme |
|----------|-------|-----------|
| P0       | 17    | Core wiring (dreaming LLM, discovery HTTP, gateway methods, privacy tests) |
| P1       | 42    | Integration testing, decomposition, CLI completion, security verification |
| P2       | 21    | Technology upgrades, client verification, documentation |
| P3       | 12    | Cleanup, minor improvements, nice-to-haves |
| **Total** | **92** | |

### Recommended Sprint Order

**Sprint 1 (v0.2.0 target)**: P0-01 through P0-07, P0-17, P0-21, P0-22, P0-24 -- Core wiring and critical gaps.
**Sprint 2 (v0.3.0 target)**: P0-08 through P0-16, P0-18 through P0-20 -- Complete daemon wiring and self-learning.
**Sprint 3 (v0.4.0 target)**: P1 testing, decomposition, CLI completion.
**Sprint 4 (v0.5.0 target)**: P2 tech upgrades, client verification, documentation.
**Ongoing**: P3 cleanup items addressed opportunistically.
