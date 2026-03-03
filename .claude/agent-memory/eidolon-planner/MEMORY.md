# Eidolon Planner Agent Memory

## Architecture Decisions
- Claude Code CLI as engine (managed subprocess, not custom runtime)
- IClaudeProcess abstraction for testability
- 3-database split: memory.db, operational.db, audit.db
- Event Bus persisted to SQLite for crash recovery
- ComplEx embeddings for Knowledge Graph (not TransE)
- multilingual-e5-small for embeddings (384-dim, German support)
- RRF fusion for hybrid search (BM25 + vector)

## Design References
- docs/design/ARCHITECTURE.md -- core architecture
- docs/design/COGNITIVE_LOOP.md -- main loop design
- docs/design/MEMORY_ENGINE.md -- memory system
- docs/design/CLAUDE_INTEGRATION.md -- Claude Code integration
- docs/design/SECURITY.md -- secrets, GPU auth, GDPR
- docs/design/TESTING.md -- test strategy, FakeClaudeProcess

## Codebase Structure (Verified March 2026 Audit v3)
- packages/protocol/src/ -- 22 files, ~1,337 lines (config.ts=391, 16 type files)
- packages/core/src/ -- 90+ source files, ~19,685 lines across 17 modules
- packages/cli/src/ -- 21 files, ~3,409 lines (12 command files + utils)
- packages/test-utils/src/ -- 6 files, ~360 lines
- services/gpu-worker/src/ -- 8 Python files, ~1,156 lines
- apps/desktop/ -- Tauri 2.0 + Svelte + Rust, ~4,852 lines (6 routes, 6 stores, Rust backend 252 lines)
- apps/ios/ -- Swift/SwiftUI, ~2,790 lines (3 views, 3 viewmodels, 6 services incl AudioService)
- apps/web/ -- SvelteKit dashboard, ~5,090 lines (6 routes, 6 stores, hooks)
- deploy/ -- systemd, launchd, Windows service files, ~913 lines
- Total source: ~38,442 lines (2.8x original estimate of ~13,810)
- Tests: 72 files, ~916 test() + 13 it() definitions, ~17,812 test lines

## Live Status (March 3, 2026 -- verified live run)
- Version: 0.1.5 released, 0.1.6 release PR pending (PR #8)
- Tests: 1,197 pass (1,069 core + 104 cli + 24 test-utils), 6 skip (embeddings model slow tests), 0 fail
- TypeCheck: 0 errors across all packages including apps
- Lint: 3 Biome errors in protocol (import order + formatting only, safe fix)
- Open GitHub Issues: 0
- Golden dataset: 105 annotated turns (plan requires 50+) -- G-02 is RESOLVED
- Prometheus /metrics: FULLY IMPLEMENTED (prometheus.ts + wiring.ts + gateway /metrics handler + tests) -- G-05 is RESOLVED
- Integration Plan (Tiers 1-3, Sprints 1-12) all committed to main

## Gap Status (updated from v3 audit)
RESOLVED since audit v3:
- G-02: Golden dataset now has 105 turns (was 3 at audit time)
- G-05: Prometheus /metrics IS implemented (MetricsRegistry, wiring.ts, gateway handler, 2 tests)

Still open:
- HIGH: G-12 -- iOS .xcodeproj missing (source files exist, SETUP.md has manual instructions)
- MEDIUM: G-06 -- DND schedule enforcement basic (no timezone tests)
- MEDIUM: G-07 -- HA entity resolution is MCP-passthrough only (by design)
- LOW: G-01, G-08, G-10, G-11, G-14, G-15 (cosmetic/structural)

## Key File Paths (line counts verified v2)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/claude/manager.ts -- ClaudeCodeManager (232 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/search.ts -- Hybrid search (344 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/extractor.ts -- Memory extraction (440 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/loop/cognitive-loop.ts -- PEAR cycle (374 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/loop/event-bus.ts -- Persisted EventBus (485 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/channels/telegram/channel.ts -- Telegram (446 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/gateway/server.ts -- WebSocket gateway (1001 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/daemon/index.ts -- Full daemon lifecycle (857 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/secrets/store.ts -- AES-256-GCM secret store (347 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/knowledge-graph/communities.ts -- Louvain (518 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/knowledge-graph/entities.ts -- KG entities (487 lines)
- /Users/manuelguttmann/Projekte/eidolon/packages/core/src/memory/knowledge-graph/complex.ts -- ComplEx (396 lines)

## Integration Plan (March 2026)
- docs/INTEGRATION_PLAN.md -- 1,128 lines, 12 sprints, 43 findings
- 24 BUILD, 7 REJECT, 4 ALREADY DONE, 8 DEFER
- Tier 1 (S1-4): memory consolidation, /metrics endpoint, context-aware responses, daily digest
- Tier 2 (S5-8): approval workflow, automations, webhooks, MCP templates
- Tier 3 (S9-12): Discord channel, research mode, user profiles, /health dashboard
- Already implemented: OpenAI REST API, remote control/QR, GDPR export, auto-lint/test
- Key extension points: gateway registerHandler(), EventBus VALID_EVENT_TYPES, Channel interface
- New tables needed in operational.db: feedback, approval_requests, webhook_endpoints, webhook_log

## Patterns Learned
- Always compare plan docs against actual code, especially Zod schemas
- Structural deviations (inlined validators, merged cost calculators) are common and acceptable
- Beyond-plan modules exist: discovery/, privacy/, audit/, notifications/, daemon/
- CLI may have stubs while core modules are fully implemented (wiring gap)
- Gateway defaults to 127.0.0.1 (more secure than plan's 0.0.0.0)
- Test count massively exceeds plan estimates (871 actual vs 43 planned for Phase 0)
- Gateway uses registerHandler(method, handler) pattern for JSON-RPC method routing
- EventBus has a VALID_EVENT_TYPES Set that must be extended for new event types
- Channel interface is well-defined in protocol; new channels follow TelegramChannel pattern
- MessageRouter in router.ts handles DND with timezone support via Intl.DateTimeFormat
- MetricsRegistry in prometheus.ts has full exposition format WITH HTTP /metrics endpoint in gateway
- Golden dataset grew from 3 to 105 entries between audit v3 and live code check
- 6 skipped tests are all in embeddings.test.ts (behind RUN_SLOW env var, model download)
- Lint issues are formatting-only in protocol (import ordering, whitespace) -- safe auto-fix
- Integration Plan Tiers 1-3 (12 sprints, 43 findings) all merged to main before v0.1.6
