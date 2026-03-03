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

## Completeness Status (Audit v3, March 2026)
Overall: ~92% complete. 0 CRITICAL, 2 HIGH, 3 MEDIUM, 6 LOW open gaps.
Full report: docs/COMPLETENESS_AUDIT.md

v3 corrections (false negatives in v2):
- G-03 RESOLVED: PDF indexing IS implemented (dynamic pdf-parse import, indexPdfFile())
- G-04 RESOLVED: Entity resolution thresholds ARE configurable (constructor param)
- G-09/G-13 RESOLVED: iOS voice IS implemented (AudioService.swift, AVAudioSession+AVAudioEngine)

HIGH gaps:
1. G-02: Golden dataset has 3 entries (need 50+) -- Phase 2 exit criterion
2. G-12: iOS .xcodeproj missing (source files exist, SETUP.md has manual instructions)

MEDIUM gaps:
1. G-05: Prometheus /metrics endpoint (no export, token tracker only)
2. G-06: DND schedule enforcement basic (no timezone tests)
3. G-07: HA entity resolution is MCP-passthrough only

LOW gaps:
1. G-01: config/validator.ts inlined in loader.ts
2. G-08: CLI learning command is stub (core module exists)
3. G-10: Desktop WCAG 2.1 AA not verified (no aria-* attrs)
4. G-11: Tauri updater pubkey is placeholder
5. G-14: iOS VoiceOver accessibility missing
6. G-15: Glossary/troubleshooting docs missing

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

## Patterns Learned
- Always compare plan docs against actual code, especially Zod schemas
- Structural deviations (inlined validators, merged cost calculators) are common and acceptable
- Beyond-plan modules exist: discovery/, privacy/, audit/, notifications/, daemon/
- CLI may have stubs while core modules are fully implemented (wiring gap)
- Gateway defaults to 127.0.0.1 (more secure than plan's 0.0.0.0)
- Test count massively exceeds plan estimates (871 actual vs 43 planned for Phase 0)
