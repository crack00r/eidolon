# Eidolon Execution Plan

> Generated: 2026-03-06
> Goal: Implement ALL 92 tasks from TASK_LIST.md -- no stubs, no mock data, everything real.

## Execution Strategy

Tasks are grouped into **Waves** based on dependencies. Within each wave, tasks run in **parallel agents**.
After each wave completes, **audit agents** verify correctness and test coverage.

## Wave 1: Foundation (must complete first -- unblocks everything)

These tasks have NO dependencies and don't conflict with each other.

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P0-01 | Decompose daemon/index.ts god object | eidolon-coder | worktree |
| P0-17 | Fix 4 Biome lint warnings | eidolon-coder | worktree |
| P0-21 | Privacy consent.ts test coverage | eidolon-tester | worktree |
| P0-22 | Privacy retention.ts test coverage | eidolon-tester | worktree |
| P0-23 | Audit logger.ts test coverage | eidolon-tester | worktree |
| P0-05+P0-20 | HTTP crawling for discovery (Reddit, HN, GitHub, RSS) | eidolon-coder | worktree |
| P1-57 | Fix README test count | eidolon-coder | worktree |

**Why P0-01 first**: The daemon god object MUST be decomposed before we can wire anything into it.
All "wire X in daemon" tasks in Wave 2 depend on the clean structure from P0-01.

## Wave 2: Core Wiring (after daemon decomposition)

Wire all existing-but-disconnected modules into the daemon.

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P0-02 | Wire KG entities/relations into MemoryInjector | eidolon-coder | worktree |
| P0-03 | Wire REM dreaming LLM calls | eidolon-coder | worktree |
| P0-04 | Wire NREM dreaming LLM calls | eidolon-coder | worktree |
| P0-06 | Wire Voice STT pipeline | eidolon-coder | worktree |
| P0-08 | Wire Discord channel in daemon | eidolon-coder | worktree |
| P0-10 | Wire ConfigWatcher for hot-reload | eidolon-coder | worktree |
| P0-11 | Wire DocumentIndexer | eidolon-coder | worktree |
| P0-12 | Wire ResearchEngine | eidolon-coder | worktree |
| P0-13 | Wire Profile system | eidolon-coder | worktree |
| P0-14 | Wire Feedback system | eidolon-coder | worktree |
| P0-15 | Wire user:approval to ApprovalManager | eidolon-coder | worktree |
| P0-16 | Wire scheduler:task_due to execution | eidolon-coder | worktree |
| P0-09 | Replace OpenAI compat stubs with real routing | eidolon-coder | worktree |

## Wave 3: Gateway & Self-Learning (after core wiring)

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P0-07 | Implement ~20 gateway methods (chat.send, memory.search, etc.) | eidolon-coder | worktree |
| P0-18 | Wire ComplEx training to KG data | eidolon-coder | worktree |
| P0-19 | Wire Louvain community detection | eidolon-coder | worktree |
| P1-12 | Relevance filter with real LLM scoring | eidolon-coder | worktree |
| P1-13 | Safety classifier verification | eidolon-coder | worktree |
| P1-14 | Git worktree implementation pipeline | eidolon-coder | worktree |
| P1-15 | Learning journal generation | eidolon-coder | worktree |
| P1-16 | CLI learning approve command | eidolon-coder | worktree |

## Wave 4: Integration Testing (after wiring)

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P0-24 | E2E daemon integration test | eidolon-tester | worktree |
| P0-25 | Circuit breaker failure testing | eidolon-tester | worktree |
| P1-05 | Energy budget verification | eidolon-tester | worktree |
| P1-06 | Session interruption testing | eidolon-tester | worktree |
| P1-08 | E2E Telegram flow test | eidolon-tester | worktree |
| P1-09 | E2E WhatsApp flow test | eidolon-tester | worktree |
| P1-10 | E2E Email flow test | eidolon-tester | worktree |
| P1-22 | GDPR cascading delete verification | eidolon-tester | worktree |
| P1-23 | API key subprocess isolation verification | eidolon-tester | worktree |
| P1-24 | Content sanitization verification | eidolon-tester | worktree |
| P1-43 | Backup/restore cycle test | eidolon-tester | worktree |
| P1-44 | Gateway server tests | eidolon-tester | worktree |
| P1-45 | Telegram channel tests | eidolon-tester | worktree |
| P1-46 | Scheduler automation tests | eidolon-tester | worktree |
| P1-49 | ConfigWatcher hot-reload tests | eidolon-tester | worktree |
| P1-50 | Rate limiter tests | eidolon-tester | worktree |
| P1-51 | Cert manager tests | eidolon-tester | worktree |
| P1-52 | Plugin lifecycle/sandbox tests | eidolon-tester | worktree |

## Wave 5: Code Quality & Decomposition (parallel with Wave 4)

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P1-26 | Split gateway/server.ts | eidolon-coder | worktree |
| P1-27 | Fix lint warnings | eidolon-coder | worktree |
| P1-28 | Split memory/store.ts | eidolon-coder | worktree |
| P1-29 | Split document-indexer.ts | eidolon-coder | worktree |
| P1-30 | Split memory/extractor.ts | eidolon-coder | worktree |
| P1-31 | Split email/channel.ts | eidolon-coder | worktree |
| P1-32 | Split calendar/manager.ts | eidolon-coder | worktree |
| P1-33 | Split communities.ts | eidolon-coder | worktree |
| P1-34 | Split approval-manager.ts | eidolon-coder | worktree |
| P1-35 | Split research/engine.ts | eidolon-coder | worktree |
| P1-36 | Split event-bus.ts | eidolon-coder | worktree |
| P1-37 | Split cli/learning.ts | eidolon-coder | worktree |

## Wave 6: Voice, GPU, CLI, Channels (after core stable)

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P1-17 | Wire GPU TTS into response pipeline | eidolon-coder | worktree |
| P1-18 | Sentence-level TTS with Intl.Segmenter | eidolon-coder | worktree |
| P1-19 | TTS fallback chain | eidolon-coder | worktree |
| P1-20 | Voice state machine | eidolon-coder | worktree |
| P1-21 | Realtime voice WebSocket | eidolon-coder | worktree |
| P1-04 | Adaptive rest duration | eidolon-coder | worktree |
| P1-07 | Backpressure testing | eidolon-tester | worktree |
| P1-11 | CLI channel status | eidolon-coder | worktree |
| P1-25 | HA policy verification | eidolon-tester | worktree |
| P1-55 | CLI plugin commands | eidolon-coder | worktree |
| P1-56 | CLI llm commands | eidolon-coder | worktree |

## Wave 7: Documentation, DevOps, Polish

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P1-58 | npm publish setup | eidolon-coder | worktree |
| P1-59 | INSTALLATION.md | eidolon-coder | worktree |
| P1-60 | Onboard wizard verification | eidolon-tester | worktree |
| P1-61 | ROADMAP.md update | eidolon-coder | worktree |
| P1-62 | CONFIGURATION.md update | eidolon-coder | worktree |
| P1-63 | Gateway API docs | eidolon-coder | worktree |
| P1-64 | Deployment docs | eidolon-coder | worktree |
| P1-66 | CI pipeline verification | eidolon-tester | worktree |
| P1-67 | Docker Compose dev | eidolon-coder | worktree |
| P1-68 | systemd verification | eidolon-tester | worktree |
| P1-69 | launchd verification | eidolon-tester | worktree |
| P1-71 | Release workflow | eidolon-coder | worktree |
| P2-03 | Workspace SOUL.md template | eidolon-coder | worktree |

## Wave 8: Technology Upgrades & P2/P3

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P1-01 | Search relevance golden dataset | eidolon-tester | worktree |
| P1-02 | PageRank for entity importance | eidolon-coder | worktree |
| P1-03 | Memory compression dedup | eidolon-coder | worktree |
| P1-47 | Digest builder tests | eidolon-tester | worktree |
| P1-48 | GPU worker/manager tests | eidolon-tester | worktree |
| P1-53 | Load/stress testing | eidolon-tester | worktree |
| P1-54 | Chaos testing | eidolon-tester | worktree |
| P2-01 | Standardize error handling | eidolon-coder | worktree |
| P2-02 | CLI console.log cleanup | eidolon-coder | worktree |

## Wave 9: Client Apps & Remaining

| ID | Task | Agent Type | Isolation |
|---|---|---|---|
| P2-06 | Embedding model evaluation | eidolon-planner | - |
| P2-07 | Graphiti evaluation | eidolon-planner | - |
| P2-08 | Qwen3-8B evaluation | eidolon-planner | - |
| P2-09 | Bun.serve() evaluation | eidolon-planner | - |
| P2-10 | Desktop app verification | eidolon-tester | - |
| P2-11 | iOS app verification | eidolon-tester | - |
| P2-12 | Web dashboard verification | eidolon-tester | - |
| P1-38-P1-42 | Remaining file splits | eidolon-coder | worktree |
| P1-65 | Architecture diagram update | eidolon-coder | worktree |
| P2-04 | Embedding tests in CI | eidolon-coder | worktree |
| P2-05 | Golden dataset expansion | eidolon-tester | worktree |
| P2-13 | Desktop accessibility | eidolon-tester | - |
| P2-14 | iOS VoiceOver | eidolon-tester | - |
| P1-70 | Windows service verification | eidolon-tester | - |
| P3-01 to P3-06 | All P3 cleanup items | eidolon-coder | worktree |

## Audit Strategy

After EACH wave completes:
1. Run `pnpm -r test` -- ALL tests must pass
2. Run `pnpm -r typecheck` -- ZERO type errors
3. Run `pnpm -r lint` -- ZERO lint errors
4. Launch eidolon-reviewer agents to audit each changed module
5. Launch eidolon-tester agents to verify no stubs/mock data remain
6. Commit and push if all checks pass

## Merge Strategy

Each wave's worktrees merge sequentially:
1. Wave completes -> all worktree branches created
2. Merge each branch one by one, resolving conflicts
3. Run full test suite after each merge
4. If tests fail, fix before merging next branch

## Standing Orders
- `gh auth switch --user crack00r` before pushing
- Conventional commits: `feat(scope): description`
- No stubs, no mock data, everything must be real implementations
- Every function must have real logic, not placeholders
