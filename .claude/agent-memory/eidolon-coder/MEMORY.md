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

## Desktop App (Tauri)
- Tauri CLI available via `cargo tauri` (cargo-tauri crate)
- Updater signing keys: `cargo tauri signer generate -w ~/.tauri/eidolon.key --ci -p ""`
- Public key goes in `apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`
- Private key stored at `~/.tauri/eidolon.key` (NEVER in repo)
- CI uses `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets
- Desktop typecheck: `pnpm --filter @eidolon/desktop typecheck` (uses svelte-check)
- Pre-existing svelte-check errors in `src/routes/memory/+page.svelte` (unused vars) - not blocking
