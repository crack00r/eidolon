# Testing Strategy

> **Status: Implemented — v0.1.x. This document describes the design; see source code for implementation details.**
> Created 2026-03-01 based on [expert review findings](../REVIEW_FINDINGS.md) (C-1).

## Overview

Testing is a first-class concern in Eidolon. The project uses `bun test` as the test runner (built into Bun, Vitest-compatible API) with a layered testing strategy.

## Test Pyramid

```
        ┌─────────┐
        │  E2E    │  Few: full daemon start → Telegram message → response
        │  Tests  │  Slow (~30s), uses FakeClaudeProcess
        ├─────────┤
        │ Integr- │  Medium: module interactions, database operations,
        │ ation   │  event bus flow. Uses FakeClaudeProcess + real SQLite.
        ├─────────┤
        │  Unit   │  Many: pure functions, config validation, crypto,
        │  Tests  │  search ranking, circuit breakers, retry logic.
        │         │  Fast (<1s), no I/O.
        └─────────┘
```

## Test Infrastructure (Phase 0)

Phase 0 establishes the foundation:

- [ ] `bun test` configuration with coverage reporting
- [ ] Test directory structure mirroring `src/`
- [ ] `@eidolon/test-utils` shared package with helpers
- [ ] CI pipeline running tests on every PR

```
packages/
├── core/
│   ├── src/
│   │   ├── config.ts
│   │   └── security/secrets.ts
│   └── test/
│       ├── config.test.ts
│       └── security/secrets.test.ts
├── test-utils/               # Shared test utilities
│   └── src/
│       ├── fake-claude.ts    # FakeClaudeProcess
│       ├── test-db.ts        # In-memory SQLite helpers
│       └── fixtures.ts       # Shared test data
```

## FakeClaudeProcess (Phase 1)

The most critical test utility. Replaces the real Claude Code CLI in tests.

```typescript
import { IClaudeProcess, StreamEvent } from '@eidolon/core';

/**
 * Test double for Claude Code CLI. Returns configured responses
 * without any API calls or subprocess spawning.
 */
class FakeClaudeProcess implements IClaudeProcess {
  private responses: StreamEvent[];
  private started = false;
  public startCallArgs?: { message: string; options: SessionOptions };

  constructor(responses: StreamEvent[] = []) {
    this.responses = responses;
  }

  /** Configure responses for the next invocation */
  static withResponse(text: string): FakeClaudeProcess {
    return new FakeClaudeProcess([
      { type: 'assistant', content: text },
      { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } },
    ]);
  }

  /** Configure a tool use response */
  static withToolUse(tool: string, input: unknown, result: string): FakeClaudeProcess {
    return new FakeClaudeProcess([
      { type: 'tool_use', tool, input },
      { type: 'tool_result', output: result },
      { type: 'assistant', content: 'Done.' },
      { type: 'done', usage: { inputTokens: 200, outputTokens: 100 } },
    ]);
  }

  /** Simulate an error */
  static withError(message: string): FakeClaudeProcess {
    return new FakeClaudeProcess([
      { type: 'error', message },
    ]);
  }

  async start(message: string, options: SessionOptions): Promise<void> {
    this.startCallArgs = { message, options };
    this.started = true;
  }

  async *streamResponses(): AsyncGenerator<StreamEvent> {
    if (!this.started) throw new Error('Process not started');
    for (const event of this.responses) {
      yield event;
    }
  }

  async interrupt(): Promise<void> { /* no-op in tests */ }
  kill(): void { /* no-op in tests */ }
}
```

### Usage in Tests

```typescript
import { describe, test, expect } from 'bun:test';
import { ClaudeCodeManager } from '../src/brain';
import { FakeClaudeProcess } from '@eidolon/test-utils';

describe('ClaudeCodeManager', () => {
  test('sends message and returns response', async () => {
    const fake = FakeClaudeProcess.withResponse('Hello, Manuel!');
    const manager = new ClaudeCodeManager({ processFactory: () => fake });

    const response = await manager.sendMessage('Hello');

    expect(response.text).toBe('Hello, Manuel!');
    expect(fake.startCallArgs?.message).toBe('Hello');
  });

  test('rotates accounts on rate limit', async () => {
    const fake1 = FakeClaudeProcess.withError('rate_limit');
    const fake2 = FakeClaudeProcess.withResponse('OK');
    let callCount = 0;
    const manager = new ClaudeCodeManager({
      processFactory: () => callCount++ === 0 ? fake1 : fake2,
      accounts: [account1, account2],
    });

    const response = await manager.sendMessage('Test');
    expect(response.text).toBe('OK');
    expect(callCount).toBe(2);
  });
});
```

## Test Categories by Phase

### Phase 0: Foundation
| Test | Type | What It Verifies |
|---|---|---|
| Config loading from JSON | Unit | Zod schema validation, defaults |
| Config env overrides | Unit | `EIDOLON_*` env vars override JSON |
| Config invalid values | Unit | Clear error messages for bad config |
| Secret encryption/decryption | Unit | AES-256-GCM round-trip, wrong password fails |
| Secret store CRUD | Integration | Set, get, list, delete operations on encrypted file |
| Database migration | Integration | Schema creation, migration ordering, rollback |
| Database concurrent access | Integration | WAL mode, concurrent reads, write serialization |
| CLI argument parsing | Unit | All subcommands parse correctly |
| `eidolon doctor` checks | Integration | Bun version, Claude Code, config, database |

### Phase 1: Brain
| Test | Type | What It Verifies |
|---|---|---|
| Send message, get response | Integration | Full message flow with FakeClaudeProcess |
| Streaming response parsing | Unit | JSON stream → StreamEvent parsing |
| Account rotation on rate limit | Integration | Failover to next account |
| All accounts exhausted | Integration | Proper error, no crash |
| Workspace preparation | Integration | CLAUDE.md, MEMORY.md, SOUL.md written |
| Session resumption | Integration | `--resume` flag used for follow-ups |
| Tool restriction by session type | Unit | Correct `--allowedTools` per session |
| Token cost tracking | Integration | Usage recorded in database |

### Phase 2: Memory
| Test | Type | What It Verifies |
|---|---|---|
| Memory extraction (golden dataset) | Integration | >80% precision on annotated conversations |
| Rule-based extraction | Unit | Pattern matching for facts/preferences/decisions |
| Hybrid search (BM25 + vector) | Integration | RRF fusion returns relevant results |
| Graph walk expansion | Integration | Connected memories included in results |
| ComplEx training convergence | Unit | Score improves over epochs on known triples |
| Link prediction accuracy | Unit | Predicted triples match expected |
| Entity deduplication | Unit | Configurable thresholds per type |
| Dreaming housekeeping | Integration | Duplicates merged, expired pruned |
| MEMORY.md injection | Integration | Top-K memories formatted correctly |

### Phase 3: Cognitive Loop
| Test | Type | What It Verifies |
|---|---|---|
| User message → immediate response | Integration | Priority override works |
| Event bus persistence | Integration | Events survive simulated crash |
| Circuit breaker transitions | Unit | closed → open → half-open → closed |
| Backpressure drops low-priority | Unit | Queue threshold enforced |
| Energy budget enforcement | Unit | Spending tracked, limits enforced |
| Graceful shutdown | Integration | Pending events persisted, clean exit |
| Session interruption for priority | Integration | Lower priority paused correctly |

### Phase 4-9: (Test plans developed when phase begins)

## Golden Datasets

For evaluating ML-dependent components, maintain golden datasets:

### Memory Extraction Golden Dataset
- 50+ annotated conversation turns (German and English)
- Each turn labeled with expected extractions: facts, decisions, preferences
- Stored in `packages/core/test/fixtures/golden/extraction/`
- Format: `{ input: { user, assistant }, expected: { facts: [], decisions: [], ... } }`
- Updated whenever extraction prompts change

### Search Relevance Golden Dataset
- 30+ queries with expected memory rankings
- Covers: exact match, semantic, German language, graph-connected
- Stored in `packages/core/test/fixtures/golden/search/`

## CI Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run lint        # biome check

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run typecheck   # tsc --noEmit

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test --coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v4
```

## Coverage Targets

| Phase | Target | Rationale |
|---|---|---|
| Phase 0 | 80% on config, secrets | Foundation must be solid |
| Phase 1 | 70% on brain module | Complex subprocess interaction |
| Phase 2 | 60% on memory module | ML components are harder to test deterministically |
| Phase 3+ | 60% overall | Maintain as complexity grows |

Coverage is tracked but not enforced as a gate — the goal is meaningful tests, not coverage theater.
