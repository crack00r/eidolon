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

## Codebase Structure (Verified March 6, 2026 -- Full Audit v7)
- packages/protocol/src/ -- 22 files, ~3,499 lines
- packages/core/src/ -- 90+ source files, ~37,476 lines across 30+ modules
- packages/core tests -- 104 test files, ~30,647 lines
- packages/cli/src/ -- 21 files, ~4,223 lines (20 command files + utils)
- packages/test-utils/src/ -- 6 files, ~717 lines
- services/gpu-worker/src/ -- 8 Python files, ~1,156 lines
- apps/desktop/ -- Tauri 2.0 + Svelte + Rust, ~4,852 lines
- apps/ios/ -- Swift/SwiftUI, ~2,790 lines (24 Swift files)
- apps/web/ -- SvelteKit dashboard, ~5,090 lines (45 files)
- deploy/ -- systemd, launchd, Windows service files
- Total source: ~60,000+ lines
- Tests: 117 test files, 1,718 test() calls, ~30,647 test lines

## Live Status (March 6, 2026 -- verified live run)
- Version: 0.1.6 released (PR #8 merged)
- Tests: 1,538 core + 112 cli + 24 test-utils = 1,674 passing, 0 fail
- TypeCheck: 0 errors across all 6 packages (protocol, core, cli, test-utils, desktop, web)
- Open GitHub Issues: 0, Open PRs: 0
- All 119 commits on main, clean working tree
- All v1.2 + v2.0 features implemented (WhatsApp, Email, OTel, Plugins, Local LLM)
- V1.2_V2.0_PLAN.md header is STALE -- says "Planning" but code is committed

## Gap Status (updated March 4, 2026 -- audit v6)
13 of 15 gaps resolved. Only 2 LOW gaps remain:
- LOW: G-01 -- config/validator.ts inlined in loader.ts (ACCEPTED, structural only)
- LOW: G-10 -- Desktop WCAG 2.1 AA not formally verified (66 ARIA attrs exist, needs checklist pass)

All HIGH/MEDIUM gaps resolved:
- G-07 RESOLVED: HAEntityResolver (265 lines) with exact/fuzzy/semantic matching
- G-11 RESOLVED: Tauri pubkey is real minisign key (A235525764C1D161)
- G-12 RESOLVED: iOS CI with xcodegen exists, .xcodeproj intentionally not committed

TODOs in production code (4 total, all benign):
- apps/ios/PushNotificationService.swift:71 -- "TODO: Send token to Eidolon Core server via WebSocket" (feature gap)
- apps/web/hooks.server.ts:17 -- "TODO: In production, add report-to CSP directive" (security enhancement)
- packages/core extractor.ts:141 -- TODO regex pattern (intentional, for memory extraction)
- packages/core daemon-memory-integration.test.ts:279 -- TODO in test fixture data (not real TODO)

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

## Post-v1.0 Plans (all implemented as of March 6, 2026)
v1.1 (DONE): Calendar, Advanced HA, Web Dashboard, Multi-GPU Pool, Discord, Mobile Widget
v1.2 (DONE, docs stale): WhatsApp (1,126L), Email (1,899L), OpenTelemetry (529L)
v2.0 (DONE, docs stale): Plugin System (351L), Local LLM (535L, Ollama + llama.cpp)
- WhatsApp uses injectable WhatsAppApiClient interface, no npm SDK dep (uses fetch)
- Email uses injectable IImapClient interface, no imapflow/nodemailer dep
- Discord uses injectable IDiscordClient interface, no discord.js dep
- Telegram is the ONLY channel with real npm dep (grammy)
- OTel uses real @opentelemetry/* packages (7 deps), dynamic imports
- Plugin system: npm packages in ~/.eidolon/plugins/, permission sandbox
- Local LLM: ILLMProvider in protocol, OllamaProvider + LlamaCppProvider + ClaudeProvider + ModelRouter
v1.3 (DEFERRED): Multi-user, Mobile widget enhancements
v2.1+ (FUTURE): Secondary replication, Full multi-user, Model fine-tuning
