# Eidolon Planner Agent Memory

## Architecture Decisions
- Claude Code CLI as engine (managed subprocess, not custom runtime)
- IClaudeProcess abstraction for testability (extended to ILLMProvider in v2.0)
- 3-database split: memory.db, operational.db, audit.db
- Event Bus persisted to SQLite for crash recovery
- ComplEx embeddings for Knowledge Graph (not TransE)
- multilingual-e5-small for embeddings (384-dim, German support)
- RRF fusion for hybrid search (BM25 + vector)
- scrypt KDF for secret encryption (docs updated to reflect scrypt, not Argon2id)

## Live Status (March 6, 2026 -- final audit v13)
- Version: 0.1.6 released
- Source: 236 files, ~45,617 lines (core non-test source)
- Tests: 2,405 core (1 fail, 6 skip) + 168 cli (1 fail) + 92 protocol + 24 test-utils = 2,689 pass, 2 fail, 6 skip
- TypeCheck: 0 errors across all 6 packages
- Lint: 0 errors (was 102, now clean)
- npm: @eidolon-ai/cli NOT published (404), publish workflow EXISTS in CI
- Golden datasets: 105 extraction entries (referenced by tests), 35 search queries (structure-only tests)

## All Phases Implemented (verified with code inspection)
- Phases 0-9: COMPLETE (real implementations, not stubs)
- v1.1 (Calendar, HA, Web Dashboard, Discord, Multi-GPU): COMPLETE
- v1.2 (WhatsApp, Email, OpenTelemetry): COMPLETE
- v2.0 (Plugin System, Local LLM): COMPLETE
- Dreaming REM/NREM: WIRED to ILLMProvider (graceful degradation when no provider)
- Crawlers: REAL HTTP (Reddit, HN, GitHub, RSS, arXiv) with fetch()

## Remaining Gaps (Priority Order -- final audit v13, March 6 2026)
1. npm package @eidolon-ai/cli not published (404) -- workflow exists but never triggered
2. 1 core test failure: config-reload.test.ts time-dependent (night mode multiplier)
3. 1 CLI test failure: plugin-commands.test.ts -- stale dist/index.js missing PluginRegistry export
4. Search golden dataset (35 queries) only structurally validated, no integration test for actual ranking
5. PageRank for entity importance described in MEMORY_ENGINE.md but zero code in codebase
6. voice.start/voice.stop gateway handlers are placeholder stubs (log + return config, no real voice session)
7. Search golden dataset entries reference "Argon2id" (should be scrypt) -- 3 stale entries
8. MEMORY_ENGINE.md lines 370+380 still say "TransE" (should say "ComplEx")
9. Web/Desktop/iOS apps + GPU worker: 0 tests combined (~19,670 lines untested)
RESOLVED: sqlite-vec ANN search IS implemented (vec0 + MATCH, with brute-force fallback)
RESOLVED: npm publish workflow EXISTS (.github/workflows/release-cli.yml)
RESOLVED: Doc drift (Argon2id/Leiden/MiniLM) MOSTLY fixed, 2 TransE refs remain in MEMORY_ENGINE.md
RESOLVED: DocumentWatcher with fs.watch() IS implemented and wired in daemon
RESOLVED: ConfigWatcher IS wired via config-reload.ts
RESOLVED: Lint: 0 errors (clean)
RESOLVED: Golden datasets ARE referenced by test files

## Key File Paths (verified v4)
- daemon/index.ts: 147L (orchestrator, decomposed into 11 sub-modules)
- daemon/initializer.ts: 1,025L (30+ init steps)
- daemon/event-handlers.ts: 829L (all event routing)
- daemon/gateway-wiring.ts: 519L (35+ RPC methods)
- daemon/channel-wiring.ts: 340L (Telegram, Discord, WhatsApp, Email)
- gateway/server.ts: ~740L (WebSocket + JSON-RPC)
- gateway/builtin-handlers.ts: ~580L (core RPC handlers)
- memory/search.ts: 371L (BM25 + vector + RRF + sqlite-vec ANN)
- memory/extractor.ts: 440L (hybrid extraction)
- loop/cognitive-loop.ts: 399L (PEAR cycle)
- loop/event-bus.ts: 485L (persisted pub/sub)

## Patterns Learned
- Always compare plan docs against actual code
- Gateway defaults to 127.0.0.1 (more secure than plan's 0.0.0.0)
- Gateway uses registerHandler(method, handler) for JSON-RPC routing
- EventBus has VALID_EVENT_TYPES Set for extension
- All channels except Telegram use injectable interfaces (no npm SDK deps)
- scrypt is used for KDF, NOT Argon2id (multiple docs were wrong, mostly fixed)
- Louvain is used for community detection, NOT Leiden (MEMORY_ENGINE.md fixed)
- sqlite-vec ANN IS implemented (vec0 + MATCH), with brute-force fallback
- 6 skipped tests are embeddings.test.ts (behind RUN_SLOW env var)
- config-reload test is time-dependent: fails during night hours (23:00-07:00) due to nightModeMultiplier
- CLI plugin test fails when core dist/ is stale (needs rebuild before testing)
- Dreaming gracefully degrades when no LLM provider configured (not a bug)
- Core RPC handlers ARE all implemented in gateway/rpc-handlers.ts
