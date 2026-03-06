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

## Live Status (March 6, 2026 -- deep audit v9)
- Version: 0.1.6 released (PR #8 merged)
- Tests: 1,538 core + 112 cli + 92 protocol + 24 test-utils = 1,774 passing (1,810 test() calls), 0 fail, 6 skipped
- TypeCheck: 0 errors across all 6 packages
- Lint: 4 warnings (unused private fields in caldav, google, whatsapp), 2 infos
- npm: @eidolon-ai/cli NOT published (404 from registry)
- README: claims "522 tests" but actual is 1,774 (stale)
- Total source: 98,322 lines across all packages/apps/services

## Deep Audit Findings (March 6, 2026 -- audit v8)

### Priority 1 -- Blocks v1.0
- daemon/index.ts is 2,538 lines (8.5x over 300-line limit) -- god-object, must decompose
- Self-learning discovery.ts has NO HTTP crawling (CRUD layer only, no data source)
- Dreaming REM/NREM LLM calls are STUBBED (interfaces exist, not wired to LLM)
- CI broken on main (Biome lint formatting)
- CLI not published to npm

### Priority 2 -- Should fix before v1.0
- Discord channel not wired in daemon (logs warning, skips)
- OpenAI compat API returns stub text responses
- Privacy module (consent.ts, retention.ts) has ZERO tests
- Voice STT pipeline not wired in daemon
- gateway/server.ts at 1,632 lines needs decomposition

### Integration Wiring Status (v9)
WIRED: Telegram, WhatsApp, Email, Memory injection, Gateway WS, Calendar, HA, Metrics, Plugins, Local LLM
NOT WIRED: Discord (logs warning, skips), OpenAI compat (stub), Discovery crawling (missing), Dreaming LLM (stub), Voice STT (incomplete), ConfigWatcher, DocumentIndexer, ResearchEngine, Profile, Feedback, KG entities/relations (null in MemoryInjector)
PARTIALLY WIRED: user:approval (logs only, not routed to ApprovalManager), scheduler:task_due (logs only, no execution)
GATEWAY METHODS MISSING: chat.send/stream, memory.search/delete, session.list/info, learning.list/approve/reject, voice.start/stop, feedback.submit/list, brain.getLog/triggerAction, metrics.rateLimits, llm.complete (~20 core methods)

### 28+ files exceed 300-line limit (top 5)
- daemon/index.ts: 2,538 lines
- gateway/server.ts: 1,632 lines
- memory/store.ts: 639 lines
- email/channel.ts: 590 lines
- knowledge-graph/communities.ts: 518 lines

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

## Master Task List (March 6, 2026)
- docs/TASK_LIST.md: 92 tasks total (17 P0, 42 P1, 21 P2, 12 P3)
- Modules without __tests__/: audit, privacy (GDPR-critical!), llm (tests at core level), plugins (tests at core level)
- No workspace/ template directory exists (SOUL.md, CLAUDE.md templates missing)
- CLI stubs: plugin (6 commands), llm (3 commands), channel (1 command)
- Golden dataset: 105 extraction entries, 0 search relevance entries
