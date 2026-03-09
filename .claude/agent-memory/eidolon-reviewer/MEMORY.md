# Eidolon Reviewer Agent Memory

## Review Standards
- No `any` types -- use `unknown` + narrowing
- Explicit return types on exported functions
- Zod schemas at external boundaries
- Result pattern for expected failures
- Named exports only, no default exports
- Max ~300 lines per file
- FakeClaudeProcess in tests, never real Claude Code
- Parameterized SQL, no string concatenation

## Common Review Findings
- Bare `catch {}` blocks: 151 in core/src production code (87 files). ~145 are justified
  best-effort cleanup. Watch for catches in data/security paths that silently degrade.
- Zero `as any` in production code (core/src, cli/src, protocol/src). Clean.
- Dynamic SQL column names built via string interpolation appear in store.ts and
  entities.ts. They use whitelist validation but lack explicit safety comments.
- `as TypeRow` casts from bun:sqlite queries are unavoidable.
  CRITICAL PATTERN: .get(id) as TypeRow (without | null) in update-then-re-read
  transactions -- found in memory/store.ts:239, kg/entities.ts:258, users/manager.ts:115,
  projects/manager.ts:186. These crash on concurrent delete.
  COUNT(*) queries cast without | null are acceptable (always returns a row).
- 4x `.catch(() => {})` on promises (gpu/worker.ts:352, gpu/manager.ts:362,
  claude/manager.ts:287, mcp/memory-server.ts:145) -- should log at debug level.
- Test files use `as any` to access private methods (telegram-channel.test.ts has 49).
  This pattern is fragile -- prefer testing through public API.
- Plugin loader (plugins/loader.ts) casts JSON.parse results without Zod validation.
- Sync file I/O used in some async contexts (plugins/loader.ts, learning/journal.ts).
- Duplicated utility functions across modules (e.g., rowToEntity in resolver.ts vs
  manager-utils.ts). Watch for divergence.
- Test helpers (createSilentLogger, createTestDb, createMockEventBus) duplicated
  across 6+ test files. Should be extracted to shared test-utils.
- interpolateMessage() in manager-utils.ts does not sanitize entity values before
  substitution -- markdown injection risk in MEMORY.md context.
- Unchecked Result values in sync loops (e.g., CalendarManager.syncProvider upserts).
- extractIcsField() in caldav-ics.ts builds regex from parameter without escaping.
- event-handlers-user.ts:81 silently swallows profile generation failure (no logging).

## Codebase Conventions
- SEC-H4 comments mark intentional console.warn usage in pre-logger startup code
- Biome is the linter (not ESLint). One stale eslint-disable exists in learning/safety.ts.
- Test structure: __tests__/ dirs co-located with source, bun:test runner
- Gateway enforces maxClients, uses constant-time token comparison, IP rate limiting
- VACUUM INTO requires string interpolation (SQLite limitation); validated via
  validateBackupPath() with FORBIDDEN_PATH_CHARS
- 225 production .ts files in core/src (excluding tests)
- Total test count: 2,488 (2,317 core + 171 CLI), 6 skips, 0 failures

## God-Modules to Watch
- desktop/src-tauri/src/commands.rs (1,161 lines) -- ALL 18 Tauri commands in one file
- daemon/initializer.ts (1,025 lines) -- initializes all 30+ modules
- daemon/task-executor.ts (432 lines) -- should extract executeClaudeTask
- loop/cognitive-loop.ts (416 lines) -- extract sleep/stats/isBusinessHours
- loop/event-bus.ts (481 lines) -- extract replay/drain/notify methods
- gateway/server.ts (366 lines, split into sub-modules) -- WebSocket + HTTP handling
- replication/manager.ts (456 lines) -- snapshot orchestration should be extracted
- database/schemas/operational.ts (548 lines) -- 16 migrations in one file
- desktop settings/+page.svelte (853 lines), dashboard/+page.svelte (689 lines)

## Privacy/GDPR Issues (Round 8+11)
- 3 items FIXED (empty-entity guard, safeDelete re-throw, entity name hashing)
- REMAINING: hash chain destroyed by redaction, Article 20 export unimplemented,
  FOREIGN_KEYS not enabled in production, no Result pattern

## Replication Issues (Round 7+11)
- STILL BROKEN: Split-brain fencing demotes fresher node -- DATA LOSS risk
- 3 items FIXED (snapshot abort, checksum errors, cleanup age check)
- REMAINING: HMAC optional, chunks buffered in memory, /tmp fallback

## Learning/Discovery Subsystem Issues (Round 9 Audit)
- DeduplicationChecker.isKnown() double-normalizes URLs, breaking OR url=? fallback.
- journal.ts module-level mutable counter for IDs -- collision risk across instances.
- pipeline-factory.ts splits commands by whitespace -- no spaces in paths, git flag injection.
- sanitizeContent() lacks normalizeForClassification() -- Cyrillic homoglyph bypass gap.
- router-relevance.ts throws instead of Result pattern for expected failures.
- setImplementationBranch() silently succeeds on nonexistent discovery IDs.
- logPairingUrl() logs masked URL at debug despite JSDoc saying "full URL".
- sanitizeForMarkdown() duplicated in implementation.ts and journal-export.ts.
- extractTag() duplicated in arxiv.ts vs rss.ts (different CDATA support).
- createSilentLogger() duplicated across 14+ test files.

## MCP & Claude Integration Issues (Round 9+12 Audit)
- ClaudeCodeManager DANGEROUS_ENV_KEYS missing ANTHROPIC_BASE_URL -- options.env can redirect
  API calls to a malicious proxy that captures the ANTHROPIC_API_KEY from requests.
- FIXED: MCP health check now validates command via SHELL_METACHAR_PATTERN (verified Round 12).
  REMAINING: args not validated (flag injection), config.env not key-whitelisted (LD_PRELOAD bypass).
- PARTIAL FIX: McpInstaller now validates package names via NPM_PACKAGE_NAME_RE.
  REMAINING: npm install still runs without --ignore-scripts (malicious postinstall scripts).
- ClaudeCodeManager has NO unit tests -- env-isolation.test.ts re-implements the logic
  instead of importing it, so production code and test code can diverge.
- parser.ts uses console.warn instead of structured Logger.
- discovery.ts uses greedy regex for JSON extraction instead of reusing extractJson().
- Workspace path traversal and symlink cleanup defenses are untested.

## Cognitive Loop / Event Bus Issues (Round 9+11 Audit)
- CognitiveLoop.isBusinessHours() uses naive local time (8-18 hardcoded), OVERRIDES
  RestCalculator's timezone-aware detection via context.isBusinessHours -- active bug.
- notifySubscribersAsync does NOT snapshot handler sets (race during replay).
- Atomics.wait() blocks event loop up to 100ms during SQLite contention.
- defer() performs two SQL ops without a transaction -- TOCTOU with concurrent dequeue.
- replayUnprocessed() has no guard preventing concurrent use with the loop.
- CognitiveLoop charges 1000 phantom tokens when handler reports tokensUsed=0 on success.
- task-executor casts arbitrary strings to EventType (event injection via scheduler).
- task-executor TOCTOU race: check-then-increment on concurrency counter is non-atomic.
- task-executor records costUsd=0 for all scheduled tasks (cost tracking broken).
- task-executor token estimates use chars/4 heuristic (unreliable).
- SessionManager.updateStatus/addTokens silently succeed on nonexistent session IDs.
- rpc-handlers-session: unchecked eventBus.publish Results in approve/reject handlers.
- Test gaps: task-executor (0), event-handlers-anticipation (0), rpc-handlers-session (0).

## Daemon Lifecycle Issues (Round 10+11)
- FIXED: shutdown.ts timer leak (no test file yet)
- Duplicate cleanup in performShutdown() vs teardownModules(); performShutdown doesn't await loop.stop()
- task-executor EventType cast enables injection; lifecycle.ts PID TOCTOU race
- gateway-wiring-handlers.ts 422 lines; GatewayChannel not unregistered on teardown
- config-reload.ts missing null check on newConfig.gpu.pool
- Test gaps: task-executor, event-handlers-learning/system/anticipation (all 0 tests)

## Secrets & Security Subsystem Issues (Round 9+12 Audit)
- FIXED: crypto.ts now uses Buffer.byteLength() for MAX_PLAINTEXT_LENGTH (verified Round 12)
- PASSPHRASE_SALT is a fixed non-random salt (accepted trade-off, needs docs)
- store.ts rotate() logs success before the set() call -- false audit trail on failure
- store.ts constructor JSDoc says "referenced not copied" but code does copy masterKey
- FIXED: approval-manager respond()/resolveTimeout() now use atomic UPDATE with status guard
- FIXED: approval-escalation resolveMaxEscalation() now has status='pending' guard
- NEW: createEscalatedRequest() UPDATE still lacks status='pending' guard (found Round 11)
- FIXED: circuit-breaker.ts now enforces halfOpenMaxAttempts (verified Round 11)
- approval-manager respond() does not validate respondedBy length
- metrics-bridge.ts syncIntervalMs parameter is dead code (OTel handles collection)
- Test gaps: no tests for key validation, resolveSecretRefs, crypto edge cases,
  or escalation policy functions (getTimeoutForLevel, getTimeoutAction, etc.)

## Memory System Issues (Round 10 Audit)
- mergeEntities() existence checks outside transaction -- TOCTOU race
- KGRelationStore.delete() and updateConfidence() lack transaction wrapping -- TOCTOU race
- MemoryStore.create() and createMemoryBatch() do not validate type/layer against allowed sets
- findSimilarMemories() truncation warning logic is unreliable (totalScanned = topK.length)
- console.warn fallback in store-batch.ts:90 when logger not provided (no SEC-H4 comment)
- consolidate() does not count apply failures -- returned counts don't sum to input length
- mergeContent() always picks incoming when lengths are similar -- loses existing info
- graphWalk() first iteration uses unbounded seedIds in SQL IN clause
- createEdge() upsert returns stale createdAt value (uses `now` instead of re-reading)
- withTransaction() duplicates runInTransaction() in store.ts (identical functionality)
- ConsolidationConfig not deep-merged with defaults -- partial config causes undefined thresholds
- _DEFAULT_ENTITY_RESOLUTION_THRESHOLDS unused in entities-resolution.ts
- createSilentLogger() duplicated across 7+ memory test files (14+ total across codebase)

## Workflow Engine Issues (Round 10+12 Audit)
- FIXED: retry_from now has MAX_RETRY_FROM_ATTEMPTS=3 limit (verified Round 11)
- ApiStepExecutor SSRF: DNS rebinding still unmitigated (Bun limitation).
  NEW Round 12: fetch() uses default redirect:"follow" -- attacker can redirect to internal IPs,
  completely bypassing all URL validation. Must add redirect:"error".
- Retry setTimeout callback has no error handling -- can crash process on DB failure
- FIXED: getEnabledSteps validates typeof output === "boolean" (verified Round 11)
- rowToDefinition silently returns empty steps[] on corrupted JSON -- instant completion
- sub_workflow step type declared but no executor exists -- runtime error trap
- Context update after step execution uses stale data -- loses parallel step outputs
- recoverRunningWorkflows marks steps failed but never calls handleStepFailure
- Interpolation regex \w+ excludes hyphenated step IDs despite schema allowing them
- No tests: retry_from strategy, parallel DAG, cleanupOldWorkflows, MAX_PARALLEL_STEPS
- No isolated tests for LlmStepExecutor, HaStepExecutor, MemoryStepExecutor, ChannelStepExecutor

## GPU / Voice / TTS / STT Subsystem Issues (Round 10+12 Audit)
- PARTIAL FIX: validateGpuManagerUrl/validateGpuWorkerUrl now block RFC 1918, link-local,
  fd00::/fe80:: ranges when allowPrivate=false (verified Round 12).
  REMAINING: ::ffff:169.254.169.254 bypasses checks (no IPv4-mapped IPv6 normalization).
  REMAINING: decimal/octal/hex IP encodings bypass regex checks (2130706433 = 127.0.0.1).
  REMAINING: 169.254.169.254 not in always-blocked set (allowPrivateHosts defaults to true).
- FIXED: VoiceWsHandler now has MAX_CHUNK_SIZE (64KB), MAX_AUDIO_BUFFER_SIZE (50MB),
  and closes connection on buffer overflow (verified Round 11). No tests for limits.
- SystemTtsProvider.synthesize() has no text length limit before spawning say/espeak-ng.
- RealtimeVoiceClient stores auth token in memory; not cleared on disconnect().
- manager.ts and worker.ts have ~200 lines of duplicated code (URL validation,
  readBodyWithLimit, request logic). Should extract to shared gpu-utils.ts.
- VoicePipeline.splitSentences() duplicates splitSentencesMultilingual() in tts-chunker.ts.
- event-handlers-voice.ts uses atob() loop for base64 decode (should use Buffer.from).
  No pre-decode size check on audioBase64 string.
- voice-ws-handler flushAudioForStt() hardcodes "audio/opus" MIME regardless of
  actual client codec.
- rpc-handlers-voice.ts uses module-level Map for session tracking (not crash-recoverable,
  TOCTOU race in voice.start, no tests).
- realtime-reconnect.ts ping timer not unref'd (keeps process alive during shutdown).
- Intl.Segmenter created on every splitSentencesMultilingual() call (should cache by locale).
- createSilentLogger() duplicated in 7 GPU test files (21+ total across codebase now).
- Test gaps: rpc-handlers-voice.ts (no test file), realtime-reconnect.ts (no dedicated tests),
  voice-pipeline textToSpeechChunked/interrupt, voice-ws-handler audio flush flow,
  GPUManager synthesize/readBodyWithLimit, worker.ts capacity/latency tracking.

## Scheduler / Automation Issues (Round 11 Audit)
- midnight bug: hour12:false returns "24" -- computeNextTimeInTimezone misses targetHours=0
- parseTime accepts out-of-range 12h values (13pm=25:00); markExecuted() TOCTOU race
- computeNextTimeInTimezone O(n) scan up to 2880 minutes per call
- rowToTask silently defaults corrupted schedule to "once"; no tests for cron-utils.ts

## Gateway Issues (Round 9+12 Audit)
- FIXED: Webhook routing now returns 404 for unknown endpoints; eventType validated (Round 12)
- STILL OPEN: /v1/ OpenAI compat auth failures not rate-limited (brute-force vector)
- STILL OPEN: Rate limiter evictOldest() prefers wrong entries (recently-unblocked over fresh)
- No tests: webhook-routing.ts, client-manager-auth.ts

## Desktop & Web Subsystem Issues (Round 11 Audit)
- See round11-desktop-web.md for full details
- CSP connect-src allows all ws:/wss: origins (tauri.conf.json) -- must restrict
- AppleScript injection in setup_claude_token (commands.rs) via unescaped binary path
- Massive duplication: api.ts, utils.ts, logger.ts, stores/* near-identical across apps
- Web token stored alongside settings in single sessionStorage key (XSS amplification)
- Web chat.ts missing streaming timeout; sends {message} vs desktop {text} (mismatch)
- PushEventType enum diverges between desktop and web (missing members each side)
- rand::thread_rng() used for token/key gen in Rust (should be OsRng)
- ZERO tests: GatewayClient (both), all stores (both), all Rust commands, all Svelte routes
- 9 files over 300-line limit including settings/+page.svelte (853 lines)
