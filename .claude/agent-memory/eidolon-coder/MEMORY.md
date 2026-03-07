# Eidolon Coder Agent Memory

## Project Setup
- Runtime: Bun (not Node.js)
- Package manager: pnpm workspaces
- Monorepo: packages/core, packages/cli, packages/protocol, packages/test-utils

## Key Patterns
- Result pattern for errors: `{ ok: true; value: T } | { ok: false; error: E }`
- Zod schemas at all external boundaries
- IClaudeProcess abstraction for Claude Code CLI interaction
- 3-database split: memory.db, operational.db, audit.db

## Conventions Learned
- Daemon module init uses ordered `initOrder` array of `{ name, fn }` steps in `EidolonDaemon.start()`
- Teardown in `teardownModules()` runs in reverse order (manual, not auto-reversed)
- `InitializedModules` interface tracks all initialized modules for teardown
- EventBus `subscribeAll()` returns an unsubscribe function; use for wildcard subscriptions
- EventBus `subscribe(type, handler)` also returns an unsubscribe function
- GatewayServer accepts optional `metricsRegistry` in its constructor deps
- `MetricsRegistry` is in `packages/core/src/metrics/prometheus.ts`
- For new wiring/integration code, create a separate module (e.g., `wiring.ts`) to keep files under 300 lines
- Test helpers: `createTestDb()` with in-memory SQLite + events table schema for EventBus tests
- Logger in tests: use `createLogger()` with level "error" to suppress noise

## Structured Output Integration
- `StructuredOutputParser<T>` in `packages/core/src/claude/structured-output.ts` validates Claude responses against Zod schemas
- Factory pattern for injected dependencies: create `createStructured*Fn` factories that return `LlmExtractFn` / `RelevanceScorerFn`
- `packages/core/src/memory/structured-extract.ts` - factory for LLM extraction via StructuredOutputParser
- `packages/core/src/learning/structured-relevance.ts` - factory for relevance scoring via StructuredOutputParser
- `ExtractionResponseSchema` and `RelevanceResponseSchema` define the Zod schemas for LLM output
- FakeClaudeProcess regex matchers with `^` anchors distinguish retry prompts from initial prompts
- When testing retries, place retry rule (matching `^Your previous response`) BEFORE the initial rule in addRule order

## Daemon Event Handler Wiring
- `user:message` handler in daemon delegates to `handleUserMessage()` private method
- `user:voice` handler delegates to `handleUserVoice()` which extracts text and re-delegates to message handler
- WorkspacePreparer and MemoryInjector are initialized as sub-steps of CognitiveLoop init (16f-ii, 16f-iii)
- CognitiveLoop.start() is called after `this._running = true` in daemon start (fire-and-forget, runs in background)
- MemoryInjector constructor: `(store, search, kgEntities, kgRelations, logger, options?)` -- KG args can be null
- WorkspacePreparer constructor: `(logger, workspacesDir?)` -- workspacesDir defaults to cache dir
- Token usage is estimated from text lengths when actual token counts aren't available from stream events

## Learning Crawlers
- Crawlers live in `packages/core/src/learning/crawlers/` with one file per source type
- `BaseCrawler` abstract class provides rate limiting (`rateLimitedFetch()`), sanitization, and Result wrapping
- `CrawlerRegistry` maps source types to crawler instances and provides `crawlAll()`
- `sanitizeContent()` in `crawlers/sanitize.ts` strips injection patterns and dangerous shell commands
- Source config uses `config: Record<string, string | number | boolean>` from LearningConfigSchema
- Tests use `Bun.serve({ port: 0 })` as mock HTTP server, subclass crawlers to override `rateLimitedFetch()` for URL rewriting
- `Bun.serve()` Server type requires generic parameter: `Server<unknown>`
- Pre-existing type errors in `audit/__tests__/logger.test.ts` (22 errors, all TS2532/TS18048) -- not from crawlers

## Doc-vs-Code Truth Table
- Key derivation: **scrypt** (N=2^17, r=8, p=1) -- NOT Argon2id. File: `packages/core/src/secrets/crypto.ts`
- Community detection: **Louvain** -- NOT Leiden. File: `packages/core/src/memory/knowledge-graph/communities.ts`
- Embedding model: **multilingual-e5-small** (Xenova/multilingual-e5-small) -- NOT all-MiniLM-L6-v2. File: `packages/core/src/memory/embeddings.ts`
- Vector search: **brute-force cosine similarity scan** with batching -- NOT sqlite-vec ANN. File: `packages/core/src/memory/search.ts`
- sqlite-vec: referenced in code comments as future optimization, `Vec0KnnRow` and `VEC0_TABLE_NAME` exist but are unused dead code

## Browser Automation Module
- Lives in `packages/core/src/browser/`
- `IBrowserClient` interface: navigate, snapshot, click, fill, screenshot, evaluate, close, isConnected
- `PlaywrightClient`: production impl with lazy browser launch, persistent profile, dynamic import
- `FakeBrowserClient`: test double recording calls and returning configurable responses
- `BrowserManager`: lifecycle wrapper with screenshot cache, start/stop, config guard
- `BrowserTools` (`tools.ts`): MCP-style tool definitions (6 tools: browse_navigate, browse_click, browse_fill, browse_screenshot, browse_snapshot, browse_evaluate)
- Config: `BrowserConfigSchema` in `config-services.ts`, added to `EidolonConfigSchema` as `browser: BrowserConfigSchema.default({})`
- Playwright is optional: ambient `playwright.d.ts` declaration (same pattern as `@slack/bolt`)
- Logger in tests needs full LoggingConfig: `{ level, format, directory, maxSizeMb, maxFiles }`
- Added error codes: BROWSER_NOT_AVAILABLE, BROWSER_NAVIGATION_FAILED, BROWSER_ACTION_FAILED, BROWSER_NOT_STARTED, INVALID_INPUT, INVALID_STATE, DEPENDENCY_MISSING

## Wyoming Protocol Module
- Lives in `packages/core/src/wyoming/` (4 source files + index, 3 test files, 40 tests)
- `protocol.ts`: WyomingParser (streaming), serializeEvent(), Zod schemas for all event types
- `handler.ts`: WyomingHandler processes satellite events (STT/TTS via GPU, EventBus integration)
- `server.ts`: WyomingServer TCP server with connection management, satellite allowlist
- `config.ts`: WyomingConfigSchema (enabled, port, allowedSatellites, audio settings)
- Error codes: WYOMING_CONNECTION_REJECTED, WYOMING_PROTOCOL_ERROR, WYOMING_HANDLER_FAILED
- Events table schema for tests must use `timestamp` column (not `created_at`), no `status` column
- Test logger needs full config: `{ level: "error", format: "json", directory: "", maxSizeMb: 10, maxFiles: 1 }`

## Multi-User Support
- Module: `packages/core/src/users/` (schema.ts, manager.ts, channel-resolver.ts, memory-scope.ts)
- Config: `UsersConfigSchema` in `config-services.ts`, added as `users:` in EidolonConfigSchema
- DB: `users` table in operational.db (migration v12), `user_id` column in `memories` table (migration v6 in memory.db)
- `DEFAULT_USER_ID = "default"` for backward compatibility
- `CreateUserInput` uses `z.input<>` (not `z.infer<>`) to allow partial objects with defaults
- `ScopedMemoryStore` wraps memory DB with user_id filtering (list, count, create, searchText)
- `ChannelResolver` maps channel identities to Eidolon users (auto-create, fallback to default)
- Pre-existing type errors in `workflow/` and `replication/` modules are NOT from multi-user changes

## Replication (Disaster Recovery)
- Module: `packages/core/src/replication/` (schema.ts, protocol.ts, snapshot.ts, manager.ts, health.ts)
- Config: `ReplicationConfigSchema` in `config-services.ts`, added as `replication:` in EidolonConfigSchema
- CLI: `packages/cli/src/commands/replication.ts` (status, promote, demote)
- CLI package name is `@eidolon-ai/cli` (not `@eidolon/cli`)
- Phase 1: Full DB snapshot via VACUUM INTO every 5 min; Phase 2 will add WAL streaming
- Protocol: Zod-validated JSON messages over WebSocket (heartbeat, snapshot_*, promote, demote, error)
- Snapshot flow: createSnapshot -> chunkSnapshotFile -> transfer -> createSnapshotReceiver -> finalize with checksum
- Auto-failover: secondary promotes itself after missedHeartbeatsThreshold missed heartbeats
- 46 tests across 4 test files (schema, protocol, manager, snapshot, health)

## Anticipation Engine (Proactive Intelligence)
- Module: `packages/core/src/anticipation/` (14 files, ~1225 LOC)
- Config: `AnticipationConfigSchema` in `packages/protocol/src/config-anticipation.ts`
- 5 detectors: MeetingPrep, TravelPrep, HealthNudge, FollowUp, Birthday
- Pipeline: detect -> trigger evaluate -> enrich -> compose -> publish events
- DB: `anticipation_history` + `anticipation_suppressions` tables in operational.db (migration v14)
- Event types: `anticipation:check`, `anticipation:suggestion`, `anticipation:dismissed`, `anticipation:acted`
- Templates in German (user preference), template mode is default (zero LLM tokens)
- AnticipationEngine init in `init-loop.ts` step 17c (after DigestBuilder)
- Event handlers in `event-handlers-anticipation.ts`
- 45 tests across 10 test files, all passing
- Pre-existing type errors in `replication/`, `users/`, `workflow/` modules are NOT from anticipation

## Agentic Workflows
- Module: `packages/core/src/workflow/` (15 source files + 6 test files, ~2800 LOC)
- Engine: DAG-based workflow execution, one step per PEAR cycle via EventBus
- Store: CRUD for definitions + runs + step results in operational.db (migration v15)
- Parser: NL -> WorkflowDefinition via IClaudeProcess with structured prompt
- 9 step types: llm_call, api_call, channel_send, wait, condition, transform, sub_workflow, ha_command, memory_query
- Limits: max 5 concurrent workflows, max 3 parallel steps, max 1000 definitions, max 10000 runs
- Condition evaluator: safe string comparison (==, !=, >, <, >=, <=, contains, &&, ||) -- no code execution
- Event types: workflow:trigger, workflow:step_ready, workflow:step_completed, workflow:step_failed, workflow:completed, workflow:failed, workflow:cancelled
- Crash recovery: `recoverRunningWorkflows()` re-publishes step_ready events for in-flight runs
- Variable interpolation: `{{stepId.output}}` resolved from WorkflowContext
- Store uses `store-rows.ts` for row types (auto-extracted by linter to keep files under 300 lines)
- IClaudeProcess.run() returns AsyncIterable<StreamEvent> with `content` field (not `text`)
- bun:sqlite dynamic SQL: use fixed queries with COALESCE for optional params (can't pass Record<string, unknown>)
- HAManager method is `executeService(entityId, domain, service, data?, executorFn?)`
- MemorySearch.search() takes `MemorySearchQuery` object with `text` and `limit` fields
- MemorySearchResult has `memory.content` and `memory.type` (not direct properties)
- Pre-existing type errors in dreaming module (nrem.ts, rem.ts) -- not from workflows
- 73 tests across 6 test files, all passing

## Desktop App (Tauri)
- Tauri CLI available via `cargo tauri` (cargo-tauri crate)
- Updater signing keys: `cargo tauri signer generate -w ~/.tauri/eidolon.key --ci -p ""`
- Public key goes in `apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`
- Private key stored at `~/.tauri/eidolon.key` (NEVER in repo)
- CI uses `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets
- Desktop typecheck: `pnpm --filter @eidolon/desktop typecheck` (uses svelte-check)
- Pre-existing svelte-check errors in `src/routes/memory/+page.svelte` (unused vars) - not blocking
