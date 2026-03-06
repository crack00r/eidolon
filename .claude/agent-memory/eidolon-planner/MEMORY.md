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

## Live Status (March 6, 2026 -- comprehensive audit v11)
- Version: 0.1.6 released
- Source: 280+ files, ~65,000 lines (core: 225 files, 44,681L)
- Tests: 2,317 core + 171 cli + 92 protocol + 24 test-utils = 2,604 passing, 6 skip, 0 fail
- TypeCheck: 0 errors across all 6 packages
- Lint: 102 errors (76 noExplicitAny + 66 noNonNullAssertion -- mostly test files), needs triage
- npm: @eidolon-ai/cli NOT published (404)
- Golden dataset: 105 extraction entries, 0 search relevance entries

## All Phases Implemented (verified with code inspection)
- Phases 0-9: COMPLETE (real implementations, not stubs)
- v1.1 (Calendar, HA, Web Dashboard, Discord, Multi-GPU): COMPLETE
- v1.2 (WhatsApp, Email, OpenTelemetry): COMPLETE
- v2.0 (Plugin System, Local LLM): COMPLETE
- Dreaming REM/NREM: WIRED to ILLMProvider (graceful degradation when no provider)
- Crawlers: REAL HTTP (Reddit, HN, GitHub, RSS, arXiv) with fetch()

## Remaining Gaps (Priority Order -- updated March 6, 2026)
1. ~~Doc mismatch~~ FIXED: All docs updated (Argon2id->scrypt, Leiden->Louvain, sqlite-vec note added)
2. Vector search: full table scan with 10K row cap, NOT sqlite-vec ANN indexing (will not scale)
3. Golden search relevance dataset: 0 entries (TESTING.md calls for 30+)
4. Extraction golden dataset (105 entries) NOT referenced by extractor tests
5. Graph expansion in search is a placeholder (weight configurable but no actual traversal)
6. Lint regression (102 errors) from uncommitted changes to 80 files
7. npm package @eidolon-ai/cli not published (404)
8. KG injection depends on nullable stores; may silently omit KG context from MEMORY.md
9. ConfigWatcher created but not wired to downstream consumers
10. DocumentIndexer file watcher not running (indexes on startup only)
11. voice.start/voice.stop gateway handlers are stubs (log only)
12. PageRank for entity importance described in docs but not found in code
13. Web/Desktop/iOS apps + GPU worker: 0 tests combined (~19,600 lines untested)

## Key File Paths (verified v4)
- daemon/index.ts: 147L (orchestrator, decomposed into 11 sub-modules)
- daemon/initializer.ts: 1,025L (30+ init steps)
- daemon/event-handlers.ts: 829L (all event routing)
- daemon/gateway-wiring.ts: 519L (35+ RPC methods)
- daemon/channel-wiring.ts: 340L (Telegram, Discord, WhatsApp, Email)
- gateway/server.ts: ~740L (WebSocket + JSON-RPC)
- gateway/builtin-handlers.ts: ~580L (core RPC handlers)
- memory/search.ts: 371L (BM25 + vector + RRF)
- memory/extractor.ts: 440L (hybrid extraction)
- loop/cognitive-loop.ts: 399L (PEAR cycle)
- loop/event-bus.ts: 485L (persisted pub/sub)

## Codebase Scale
| Package | Source Files | Source Lines | Test Files | Tests |
|---|---|---|---|---|
| protocol | 25 | 2,565 | 1 | 92 |
| core | 225 | 44,681 | 140 | 2,323 |
| cli | 21 | 4,797 | 10 | 171 |
| test-utils | 7 | 459 | 5 | 24 |
| desktop (Tauri+Svelte) | ~30 | ~4,921 | 0 | 0 |
| ios (Swift) | 24 | 5,417 | 0 | 0 |
| web (SvelteKit) | 34 | 8,176 | 0 | 0 |
| gpu-worker (Python) | 8 | 1,156 | 0 | 0 |

## Code Quality
- Zero `as any` in non-test source
- 13 `as unknown as` (acceptable for SQLite row typing)
- Zero TODO/FIXME/HACK comments
- 1 empty catch (log rotation, acceptable)
- All modules have tests (llm/plugins tested at core level)

## Patterns Learned
- Always compare plan docs against actual code
- Gateway defaults to 127.0.0.1 (more secure than plan's 0.0.0.0)
- Gateway uses registerHandler(method, handler) for JSON-RPC routing
- EventBus has VALID_EVENT_TYPES Set for extension
- All channels except Telegram use injectable interfaces (no npm SDK deps)
- scrypt is used for KDF, NOT Argon2id (multiple docs wrong)
- Louvain is used for community detection, NOT Leiden (MEMORY_ENGINE.md wrong)
- Vector search is full table scan, NOT sqlite-vec ANN (MEMORY_ENGINE.md wrong)
- 6 skipped tests are embeddings.test.ts (behind RUN_SLOW env var)
- Lint regression can happen from uncommitted changes
- Dreaming gracefully degrades when no LLM provider configured (not a bug)
- Core RPC handlers (chat/memory/session/learning/voice) ARE all implemented in gateway/rpc-handlers.ts, wired via daemon/core-rpc-wiring.ts
- GatewayMethod type expanded from 14 planned to 50+ actual methods
