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

## Live Status (March 2026 -- comprehensive audit v16)
- Version: 0.1.6 released
- Source: 293 non-test files, ~54,962 lines (packages only)
- Test files: 164 files, ~2,781 test() calls
- Lines by package: protocol ~2,500+ | core ~46,000+ | cli ~5,000+ | test-utils 459
- Apps: web ~5,899L (32 files) | desktop ~3,229L (18+5 rust files) | ios 5,417L (24 files)
- GPU worker: 1,156L Python (8 files)
- Total project source (excl tests): ~72,000+ lines
- TypeCheck: 0 errors; Lint: 0 errors
- npm: @eidolon-ai/cli NOT published (404), release-cli.yml workflow exists
- Daemon module: 19 files, 4,370L (decomposed from monolith)
- Golden datasets: 105 extraction entries, 35 search queries

## All Phases Implemented (verified with code inspection)
- Phases 0-9: COMPLETE (real implementations, not stubs)
- v1.1 (Calendar, HA, Web Dashboard, Discord, Multi-GPU): COMPLETE
- v1.2 (WhatsApp, Email, OpenTelemetry): COMPLETE
- v2.0 (Plugin System, Local LLM): COMPLETE
- Dreaming REM/NREM: WIRED to ILLMProvider (graceful degradation)
- Crawlers: REAL HTTP (Reddit, HN, GitHub, RSS, arXiv) with fetch()
- PageRank: IMPLEMENTED in memory/knowledge-graph/pagerank.ts

## Remaining Gaps (Priority Order -- audit v16)
1. npm @eidolon-ai/cli not published (404) -- workflow exists, never triggered
2. 1 core test failure: config-reload.test.ts (time-dependent night mode)
3. 1 CLI test failure: plugin-commands.test.ts (stale dist/index.js)
4. Search golden dataset only structurally validated, no ranking integration test
5. voice.start/voice.stop: session lifecycle + GPU check implemented but no real audio streaming
6. Web/Desktop/iOS apps + GPU worker: 0 tests combined (~15,700 lines untested)
7. 65 files exceed 300-line project rule; 10 exceed 500 lines
8. iOS app: no .xcodeproj file (Swift source exists but no Xcode project)
9. Web dashboard: manifest.json exists but no service worker (not a true PWA)
10. ClaudeProvider.complete()/stream() return empty content (routing stub by design)

## Key File Paths (verified v16)
- daemon/ total: 4,370L across 19 files (decomposed architecture)
- gateway/: 3,869L across 14 files (incl. OpenAI compat, webhooks, rate limiter)
- memory/: largest module -- search 746L, extractor 545L, store 498L
- gpu/: 3,062L across 15 files (pool, balancer, voice pipeline, WS handler)
- learning/: 2,169L across 10 files + 1,030L crawlers (7 files)
- loop/: cognitive-loop 399L, event-bus 391L

## Feature Plans Created
- Proactive Intelligence: docs/design/PROACTIVE_INTELLIGENCE.md (March 2026)
  - Anticipation Engine hooks into scheduler, not cognitive loop
  - 5 built-in detectors: meeting prep, travel prep, health nudge, follow-up, birthday
  - Zero LLM tokens in template mode; optional LLM composition via Haiku
  - New tables: anticipation_history, anticipation_suppressions (operational.db)
  - New events: anticipation:check, anticipation:suggestion, anticipation:dismissed, anticipation:acted
  - 14 new files (~1,225 lines), 10 modified files (~150 lines)

## Patterns Learned
- Always compare plan docs against actual code
- Gateway defaults to 127.0.0.1 (more secure than plan's 0.0.0.0)
- scrypt is used for KDF, NOT Argon2id
- Louvain for community detection (louvain.ts 259L), NOT Leiden
- sqlite-vec ANN IS implemented (vec0 + MATCH, with brute-force fallback)
- 6 skipped tests are embeddings.test.ts (behind RUN_SLOW env var)
- config-reload test fails during night hours (23:00-07:00)
- CLI plugin test fails when core dist/ is stale
- Dreaming gracefully degrades when no LLM provider configured
- Daemon was decomposed from monolithic files into 19 sub-modules
- ClaudeProvider intentionally delegates to session pipeline (not a bug)
